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
  summary: string;
  dueDate: string | null;
  assignee: {
    id: number;
    name: string;
    mailAddress: string;
  } | null;
  status: {
    id: number;
    name: string;
  };
}

interface BacklogUser {
  id: number;
  userId: string;
  name: string;
  mailAddress: string;
}

// ==== 環境変数 ====
const SPACE: string | undefined = process.env.BACKLOG_SPACE;
const DOMAIN: string = process.env.BACKLOG_DOMAIN || 'backlog.jp';
const API_KEY: string | undefined = process.env.BACKLOG_API_KEY;
const TIMEZONE: string = process.env.TIMEZONE || 'Asia/Tokyo';
const SKIP_HOLIDAYS: boolean = (process.env.SKIP_HOLIDAYS || 'true') === 'true';

// ==== 日付ユーティリティ（JST基準）====
const today = DateTime.now().setZone(TIMEZONE).startOf('day');
const iso = (d: DateTime): string => d.toISODate() || ''; // YYYY-MM-DD

const hd = new Holidays('JP');
const isHoliday = (d: DateTime): boolean => {
  const h = hd.isHoliday(d.toJSDate());
  return !!(h && Array.isArray(h) && h.length > 0);
};
const isWeekend = (d: DateTime): boolean => d.weekday >= 6; // 6=土, 7=日

// 翌営業日（土日・祝日をスキップ）
const nextBusinessDay = (from: DateTime): DateTime => {
  let d = from.plus({ days: 1 });
  while (isWeekend(d) || isHoliday(d)) d = d.plus({ days: 1 });
  return d;
};

// 課題の期限が当日かどうか（Backlogの dueDate は時刻付きISOで返る場合があるため日付で比較）
const isDueToday = (issue: BacklogIssue): boolean => {
  if (!issue.dueDate) return false;
  return DateTime.fromISO(issue.dueDate, { zone: TIMEZONE }).startOf('day').toISODate() === iso(today);
};

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
  return fetchJson(`${API_BASE}/users/myself?apiKey=${API_KEY}`);
};

const getProjectStatuses = async (projectId: number): Promise<BacklogStatus[]> => {
  return fetchJson(`${API_BASE}/projects/${projectId}/statuses?apiKey=${API_KEY}`);
};

const getCompletedStatusIds = async (projectIds: number[]): Promise<number[]> => {
  const completedIds: number[] = [];
  for (const projectId of projectIds) {
    const statuses = await getProjectStatuses(projectId);
    completedIds.push(...statuses.filter(s => /完了|completed/i.test(s.name)).map(s => s.id));
  }
  return completedIds;
};

const fetchAllIssues = async (params: Record<string, string>): Promise<BacklogIssue[]> => {
  const q = new URLSearchParams(params);
  const count = 100;
  let offset = 0;
  let all: BacklogIssue[] = [];
  while (true) {
    q.set('count', String(count));
    q.set('offset', String(offset));
    const page: BacklogIssue[] = await fetchJson(`${API_BASE}/issues?${q.toString()}`);
    all = all.concat(page);
    if (page.length < count) break;
    offset += count;
  }
  return all;
};

// 課題の期限を更新（PATCH /issues/:id, form-encoded）
const updateDueDate = async (issueId: number, dueDate: string): Promise<void> => {
  const url = `${API_BASE}/issues/${issueId}?apiKey=${API_KEY}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ dueDate })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`期限更新に失敗 (issue ${issueId}): HTTP ${res.status} ${text}`);
  }
};

// ==== メインロジック ====
// 要件: 本人担当・当日が期限・未完了の課題の期限を「翌営業日」に延長する（平日11:50 JST）
(async () => {
  if (!SPACE || !API_KEY) {
    throw new Error('環境変数 BACKLOG_SPACE / BACKLOG_API_KEY が未設定です。');
  }

  // 平日のみ＋祝日スキップ（手動実行で土日祝に走らせても止まるように）
  if (isWeekend(today)) {
    console.log(`土日(${iso(today)})のため実行をスキップします`);
    return;
  }
  if (SKIP_HOLIDAYS && isHoliday(today)) {
    console.log(`祝日(${iso(today)})のため実行をスキップします`);
    return;
  }

  // 本人の、当日が期限の課題を取得
  const myself = await getMyself();
  const issues = await fetchAllIssues({
    apiKey: API_KEY,
    'assigneeId[]': String(myself.id),
    dueDateSince: iso(today),
    dueDateUntil: iso(today),
    sort: 'dueDate',
    order: 'asc'
  });

  // 完了ステータスを除外し、当日期限のものだけに絞る
  const projectIds = [...new Set(issues.map(i => i.projectId))];
  const completedStatusIds = await getCompletedStatusIds(projectIds);
  const targets = issues.filter(i => isDueToday(i) && !completedStatusIds.includes(i.status.id));

  if (targets.length === 0) {
    console.log(`延長対象の課題はありません: ${iso(today)}`);
    return;
  }

  const newDue = iso(nextBusinessDay(today));
  console.log(`本日(${iso(today)})が期限の未完了課題 ${targets.length}件を ${newDue} に延長します`);

  for (const it of targets) {
    await updateDueDate(it.id, newDue);
    console.log(`  ✓ ${it.issueKey}「${it.summary}」 ${iso(today)} → ${newDue}`);
  }

  console.log('期限延長が完了しました。');
})().catch((e: Error) => {
  console.error(e);
  process.exit(1);
});
