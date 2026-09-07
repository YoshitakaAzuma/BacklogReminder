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
}

interface SlackMessage {
  text: string;
}

// ==== 環境変数 ====
const SPACE: string | undefined = process.env.BACKLOG_SPACE;          // 例: "your-space"
const DOMAIN: string = process.env.BACKLOG_DOMAIN || 'backlog.jp'; // "backlog.jp" or "backlog.com"
const API_KEY: string | undefined = process.env.BACKLOG_API_KEY;      // Backlog API key
const SLACK_WEBHOOK_URL: string | undefined = process.env.SLACK_WEBHOOK_URL;
// LINE Messaging API のチャネルアクセストークン（長期）。設定時のみLINEブロードキャスト送信。
const LINE_CHANNEL_ACCESS_TOKEN: string | undefined = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const TIMEZONE: string = process.env.TIMEZONE || 'Asia/Tokyo';
const SKIP_HOLIDAYS: boolean = (process.env.SKIP_HOLIDAYS || 'true') === 'true';
// 通知に載せる課題の対象ドメイン。担当者のメールがこのドメインの課題だけを通知する。
// （本人もこのドメインのユーザーなので自然に含まれる）
const TARGET_DOMAINS = new Set(['gemcook.com']);

// ==== 日付ユーティリティ（JST基準）====
const now = DateTime.now().setZone(TIMEZONE);
const today = now.startOf('day');
const iso = (d: DateTime): string => d.toISODate() || ''; // YYYY-MM-DD

// 深夜帯（0:00〜3:59 JST）は「期限切れ」だけを通知する
const OVERDUE_ONLY = now.hour < 4;

// ==== 祝日スキップ ====
if (SKIP_HOLIDAYS) {
  const hd = new Holidays('JP');
  const hol = hd.isHoliday(today.toJSDate());
  if (hol && Array.isArray(hol) && hol.length > 0) {
    console.log(`祝日(${hol[0].name})のため通知をスキップします: ${iso(today)}`);
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

// 課題の担当者のメールドメインが対象ドメインかどうか（担当者未設定は対象外）
const isTargetAssignee = (issue: BacklogIssue): boolean => {
  const email = issue.assignee?.mailAddress?.toLowerCase();
  if (!email) return false;
  const domain = email.slice(email.lastIndexOf('@') + 1);
  return TARGET_DOMAINS.has(domain);
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
// 要件: 対象ドメイン担当者の課題 / 期限が「当日」「期限切れ」
(async () => {
  if (!SPACE || !API_KEY || !SLACK_WEBHOOK_URL) {
    throw new Error('環境変数 BACKLOG_SPACE / BACKLOG_API_KEY / SLACK_WEBHOOK_URL が未設定です。');
  }

  // 期限の範囲：過去(期限切れ含む)〜明日までを一気に取得してグルーピング
  const since = today.minus({ days: 365 }); // 1年分拾えば十分。必要に応じて短縮可
  const until = today; // 当日まで（明日以降は対象外）

  // 担当者では絞らず、期限範囲の課題をまとめて取得（担当者は後段でドメインでフィルタ）
  const allIssues = await fetchAllIssues({
    apiKey: API_KEY,
    dueDateSince: iso(since),
    dueDateUntil: iso(until),
    sort: 'dueDate',
    order: 'asc'
  });

  // 対象ドメイン（gemcook.com）の担当者の課題のみに絞り込む（本人もこのドメインなので含まれる）
  const domainIssues = allIssues.filter(isTargetAssignee);

  // プロジェクトIDを抽出
  const projectIds = [...new Set(domainIssues.map(issue => issue.projectId))];

  // 完了ステータスのIDを取得
  const completedStatusIds = await getCompletedStatusIds(projectIds);

  // 完了ステータス以外の課題のみにフィルタリング
  const issues = domainIssues.filter(issue =>
    !completedStatusIds.includes(issue.status.id)
  );

  // グルーピング
  const groups: IssueGroups = {
    overdue: [], // 期限切れ（todayより過去）
    today: []    // 当日
  };

  for (const i of issues) {
    if (!i.dueDate) continue; // 期限なしは対象外
    const due = DateTime.fromISO(i.dueDate, { zone: TIMEZONE });
    const diffDays = Math.floor(due.diff(today, 'days').days); // due - today（日単位）

    if (diffDays < 0) groups.overdue.push(i);
    else if (diffDays === 0) groups.today.push(i);
  }

  // 表示するセクション（深夜帯は「期限切れ」のみ、それ以外は「期限切れ＋当日」）
  const shownGroups: Array<{ label: string; issues: BacklogIssue[] }> = [
    { label: '🔴 期限切れ', issues: groups.overdue }
  ];
  if (!OVERDUE_ONLY) shownGroups.push({ label: '🟠 当日', issues: groups.today });

  // 該当課題がない場合は送信しない
  const total = shownGroups.reduce((n, g) => n + g.issues.length, 0);
  if (total === 0) { console.log('該当なしのため送信しません'); return; }

  const issueUrl = (it: BacklogIssue): string => `https://${SPACE}.${DOMAIN}/view/${it.issueKey}`;
  const assigneePrefix = (it: BacklogIssue): string => (it.assignee ? `@${it.assignee.name} ` : '');

  // ---- Slack（mrkdwn: リンク記法・太字が使える）----
  const slackLine = (it: BacklogIssue): string =>
    `• ${assigneePrefix(it)}<${issueUrl(it)}|${it.issueKey}> ${it.summary} [${it.status.name}]`;
  const slackSection = (g: { label: string; issues: BacklogIssue[] }): string =>
    g.issues.length ? `*${g.label}*\n${g.issues.map(slackLine).join('\n')}` : `*${g.label}*\n（該当なし）`;
  const slackText = [
    `:spiral_calendar_pad: Backlog 期限リマインド (${iso(today)})`,
    ...shownGroups.map(slackSection)
  ].join('\n\n');

  // ---- LINE（プレーンテキスト: URLはそのまま貼るとリンク化される）----
  const lineLine = (it: BacklogIssue): string =>
    `・${assigneePrefix(it)}${it.issueKey} ${it.summary} [${it.status.name}]\n${issueUrl(it)}`;
  const lineSection = (g: { label: string; issues: BacklogIssue[] }): string =>
    g.issues.length ? `${g.label}\n${g.issues.map(lineLine).join('\n')}` : `${g.label}\n（該当なし）`;
  const lineText = [
    `🗓 Backlog 期限リマインド (${iso(today)})`,
    ...shownGroups.map(lineSection)
  ].join('\n\n');

  // ---- Slack送信 ----
  const slackPayload: SlackMessage = { text: slackText };
  const slackRes = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(slackPayload)
  });
  if (!slackRes.ok) {
    const t = await slackRes.text();
    throw new Error(`Slack送信失敗: HTTP ${slackRes.status} ${t}`);
  }
  console.log('Slackへ送信しました。');

  // ---- LINE送信（トークン設定時のみ、友だち全員へブロードキャスト）----
  if (LINE_CHANNEL_ACCESS_TOKEN) {
    // LINEのテキストは1メッセージ5000字まで
    const lineBody = lineText.length > 5000 ? `${lineText.slice(0, 4900)}\n…(以下省略)` : lineText;
    const lineRes = await fetch('https://api.line.me/v2/bot/message/broadcast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({ messages: [{ type: 'text', text: lineBody }] })
    });
    if (!lineRes.ok) {
      const t = await lineRes.text();
      throw new Error(`LINE送信失敗: HTTP ${lineRes.status} ${t}`);
    }
    console.log('LINEへ送信しました。');
  } else {
    console.log('LINE_CHANNEL_ACCESS_TOKEN 未設定のためLINE送信はスキップしました。');
  }
})().catch((e: Error) => {
  console.error(e);
  process.exit(1);
});