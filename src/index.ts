import { DateTime } from 'luxon';
import Holidays from 'date-holidays';

// ==== 型定義 ====
interface BacklogStatus {
  id: number;
  projectId: number;
  name: string;
  color: string;
  displayOrder: number;
}

interface BacklogIssue {
  id: number;
  projectId: number;
  issueKey: string;
  keyId: number;
  summary: string;
  description: string;
  dueDate: string | null;
  assignee: {
    id: number;
    userId: string;
    name: string;
    roleType: number;
    lang: string | null;
    mailAddress: string;
  } | null;
  status: {
    id: number;
    projectId: number;
    name: string;
    color: string;
    displayOrder: number;
  };
  priority: {
    id: number;
    name: string;
  };
  issueType: {
    id: number;
    projectId: number;
    name: string;
    color: string;
    displayOrder: number;
  };
  created: string;
  updated: string;
}

interface BacklogUser {
  id: number;
  userId: string;
  name: string;
  roleType: number;
  lang: string | null;
  mailAddress: string;
}

interface IssueGroups {
  overdue: BacklogIssue[];
  today: BacklogIssue[];
  in2: BacklogIssue[];
  in3: BacklogIssue[];
}

interface SlackMessage {
  text: string;
}

// ==== 環境変数 ====
const SPACE: string | undefined = process.env.BACKLOG_SPACE;          // 例: "your-space"
const DOMAIN: string = process.env.BACKLOG_DOMAIN || 'backlog.jp'; // "backlog.jp" or "backlog.com"
const API_KEY: string | undefined = process.env.BACKLOG_API_KEY;      // Backlog API key
const SLACK_WEBHOOK_URL: string | undefined = process.env.SLACK_WEBHOOK_URL;
const TIMEZONE: string = process.env.TIMEZONE || 'Asia/Tokyo';
const SKIP_HOLIDAYS: boolean = (process.env.SKIP_HOLIDAYS || 'true') === 'true';

// ==== 日付ユーティリティ（JST基準）====
const today = DateTime.now().setZone(TIMEZONE).startOf('day');
const in2 = today.plus({ days: 2 });
const in3 = today.plus({ days: 3 });
const iso = (d: DateTime): string => d.toISODate() || ''; // YYYY-MM-DD

// ==== 祝日スキップ ====
if (SKIP_HOLIDAYS) {
  const hd = new Holidays('JP');
  const hol = hd.isHoliday(today.toJSDate());
  if (hol) {
    const holidayName = Array.isArray(hol) ? hol[0]?.name || '祝日' : (hol as any)?.name || '祝日';
    console.log(`祝日(${holidayName})のため通知をスキップします: ${iso(today)}`);
    process.exit(0);
  }
}

// ==== Backlog API 基本関数 ====
const API_BASE = `https://${SPACE}.${DOMAIN}/api/v2`;

const fetchJson = async (url: string): Promise<any> => {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
};

const getMyself = async (): Promise<BacklogUser> => {
  const url = `${API_BASE}/users/myself?apiKey=${API_KEY}`;
  return fetchJson(url);
};

const getProjectStatuses = async (projectId: number): Promise<BacklogStatus[]> => {
  const url = `${API_BASE}/projects/${projectId}/statuses?apiKey=${API_KEY}`;
  return fetchJson(url);
};

const getCompletedStatusIds = async (projectIds: number[]): Promise<number[]> => {
  const completedIds: number[] = [];
  
  for (const projectId of projectIds) {
    const statuses = await getProjectStatuses(projectId);
    // 「完了」のみを対象とする
    const completedStatuses = statuses.filter(status => 
      /完了|completed/i.test(status.name)
    );
    completedIds.push(...completedStatuses.map(s => s.id));
  }
  
  return completedIds;
};

const fetchAllIssues = async (params: Record<string, string>): Promise<BacklogIssue[]> => {
  // params: object -> querystring
  const q = new URLSearchParams(params);
  // ページング
  const count = 100;
  let offset = 0;
  let all: BacklogIssue[] = [];
  while (true) {
    q.set('count', String(count));
    q.set('offset', String(offset));
    const url = `${API_BASE}/issues?${q.toString()}`;
    const page: BacklogIssue[] = await fetchJson(url);
    all = all.concat(page);
    if (page.length < count) break;
    offset += count;
  }
  return all;
};

// ==== メインロジック ====
// 要件: 自分の課題 / 期限が「残り3日」「残り2日」「当日」「期限切れ」
(async () => {
  if (!SPACE || !API_KEY || !SLACK_WEBHOOK_URL) {
    throw new Error('環境変数 BACKLOG_SPACE / BACKLOG_API_KEY / SLACK_WEBHOOK_URL が未設定です。');
  }

  const me = await getMyself();
  const assigneeId = me.id;

  // 期限の範囲：過去(期限切れ含む)〜3日後までを一気に取得してグルーピング
  const since = today.minus({ days: 365 }); // 1年分拾えば十分。必要に応じて短縮可
  const until = in3;

  // まず全ての課題を取得して、プロジェクトIDを抽出
  const allIssues = await fetchAllIssues({
    apiKey: API_KEY,
    'assigneeId[]': String(assigneeId),
    dueDateSince: iso(since),
    dueDateUntil: iso(until),
    sort: 'dueDate',
    order: 'asc'
  });

  // プロジェクトIDを抽出
  const projectIds = [...new Set(allIssues.map(issue => issue.projectId))];
  
  // 完了ステータスのIDを取得
  const completedStatusIds = await getCompletedStatusIds(projectIds);
  
  // 完了ステータス以外の課題のみにフィルタリング
  const issues = allIssues.filter(issue => 
    !completedStatusIds.includes(issue.status.id)
  );

  // グルーピング
  const groups: IssueGroups = {
    overdue: [], // 期限切れ（todayより過去）
    today: [],   // 当日
    in2: [],     // 2日前（= 期限まで残り2日）
    in3: []      // 3日前（= 期限まで残り3日）
  };

  for (const i of issues) {
    if (!i.dueDate) continue; // 期限なしは対象外
    const due = DateTime.fromISO(i.dueDate, { zone: TIMEZONE });
    const diffDays = Math.floor(due.diff(today, 'days').days); // due - today（日単位）

    if (diffDays < 0) groups.overdue.push(i);
    else if (diffDays === 0) groups.today.push(i);
    else if (diffDays === 2) groups.in2.push(i);
    else if (diffDays === 3) groups.in3.push(i);
  }

  // Slack メッセージ整形
  const issueLine = (it: BacklogIssue): string =>
    `• <https://${SPACE}.${DOMAIN}/view/${it.issueKey}|${it.issueKey}> ${it.summary} [${it.status.name}]`;

  const section = (title: string, arr: BacklogIssue[]): string =>
    arr.length
      ? `*${title}*\n${arr.map(issueLine).join('\n')}`
      : `*${title}*\n（該当なし）`;

  const text: string = [
    `<@${assigneeId}>`,
    `:spiral_calendar_pad: Backlog 期限リマインド (${iso(today)})`,
    section('🟥 期限切れ', groups.overdue),
    section('🟧 当日', groups.today),
    section('🟨 残り2日', groups.in2),
    section('🟩 残り3日', groups.in3)
  ].join('\n\n');

  // 何もなければ送らない運用にしたい場合は以下でreturn
  // const total = groups.overdue.length + groups.today.length + groups.in2.length + groups.in3.length;
  // if (total === 0) { console.log('該当なしのため送信しません'); return; }

  // Slack送信
  const slackPayload: SlackMessage = { text };
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(slackPayload)
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Slack送信失敗: HTTP ${res.status} ${t}`);
  }

  console.log('Slackへ送信しました。');
})().catch((e: Error) => {
  console.error(e);
  process.exit(1);
});