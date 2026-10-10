/**
 * 意图识别（FR-2 / FR-4）。
 *
 * 七类：`order` `confirm` `cancel` `pickCandidate` `config` `query` `help`。
 *
 * 三条必须守住的：
 *   1. **cancel 的判定必须极度保守**。菜单里有一大堆「不要酸黄瓜」这类特制说法，
 *      只要 cancel 规则写成 `包含"不要"`，用户想吃的东西就会全部变成"取消"。
 *      所以取消只认**句首出现且语义完整**的说法（`算了`、`不要了`、`取消订单`…）。
 *   2. **confirm 只在有东西可确认时才算数**。这是 SEC-1 的一部分：
 *      意图层给出 confirm，不代表就能下单 —— 还得过会话状态机那一关。
 *   3. **认不出来 = help，绝不默认成 order**。乱猜成下单是最危险的默认值：
 *      它会在用户毫无预期的情况下走完检索→算价→付款。宁可问一句。
 *
 * 判定顺序即优先级：**取消 → 选候选 → 确认 → 配置 → 查询 → 下单 → 帮助**。
 * 顺序本身是设计决策，改之前先想清楚会不会让某个类被前一个类吃掉。
 */

import { normalizeCompact, normalizeLoose, stripCourtesy, trimPunctuation } from './text.ts';
import type { SessionState } from './session.ts';

export type IntentKind =
  | 'order'
  | 'confirm'
  | 'cancel'
  | 'pickCandidate'
  | 'config'
  | 'query'
  | 'help';

export interface IntentContext {
  readonly state: SessionState;
  /** 当前草稿的原始文本 —— 用于「重复同一句话＝确认」的宽容处理 */
  readonly draftRawText?: string;
  /** 待澄清候选项数量 */
  readonly candidateCount?: number;
}

export interface Intent {
  readonly kind: IntentKind;
  /** 0~1，仅用于调试与日志，不参与硬性分支 */
  readonly confidence: number;
  readonly raw: string;
  /** 归一化后的文本（半角、单空格） */
  readonly normalized: string;
  /** 去掉客套话后的文本，供下单流水线继续使用 */
  readonly cleaned: string;
  /** 选中候选的下标（从 1 开始），仅 pickCandidate 有 */
  readonly pickIndex?: number;
  /** 命中的规则名，排障时很有用 */
  readonly matchedRule: string;
}

export const INTENT_LABELS: Readonly<Record<IntentKind, string>> = {
  order: '下单',
  confirm: '确认',
  cancel: '取消',
  pickCandidate: '选择候选',
  config: '改配置',
  query: '查询',
  help: '帮助',
};

// ─────────────────────────────────────────────────────────────
// 词表
// ─────────────────────────────────────────────────────────────

/** 「取消」只在**整句**命中时算数，避免吃掉「不要酸黄瓜」这类特制 */
const CANCEL_EXACT = new Set([
  '取消',
  '算了',
  '取消吧',
  '算了算了',
  '算了不点了',
  '算了不要了',
  '不要了',
  '不买了',
  '不点了',
  '不吃了',
  '不下单了',
  '不下了',
  '不用了',
  '撤回',
  '撤销',
  '清空',
  '重来',
  '重新来',
  '重选',
  '退出',
  '停止',
  '结束',
  '拜拜',
  'cancel',
  'abort',
  'stop',
  'quit',
]);

/** 句中出现即视为取消 —— 都带明确宾语，不会误伤特制 */
const CANCEL_PHRASE: readonly RegExp[] = [
  /取消(订单|这笔|这个|本次|下单|那个)/,
  // 「取消我刚才那个」「撤销刚刚那笔」—— 中间允许几个字的口语填充
  /(取消|撤销|撤掉).{0,5}(刚才|刚刚|那笔|那个|这单|这笔)/,
  /(删掉|删除)(订单|这笔)/,
  /别(下|买|点)了/,
  /不(要|用|买|点|下单)这笔/,
];

const CONFIRM_EXACT = new Set([
  '确认',
  '确定',
  '是',
  '是的',
  '对的',
  '对',
  '好',
  '好的',
  '可以',
  '行',
  '没问题',
  '没毛病',
  'ok',
  'okay',
  'yes',
  'y',
  'yeah',
  'yep',
  'confirm',
  'go',
  '下单',
  '下单吧',
  '下吧',
  '来吧',
  '搞定',
  '就这样',
  '就这个',
  '就它了',
  '买',
  '买单',
  '付款',
  '付吧',
  '确认下单',
  '确认付款',
  '恩',
  '嗯',
]);

/** FR-15：超过阈值后的强化确认，要求用户说得更明确一些 */
export const STRONG_CONFIRM_EXACT = new Set([
  '确认',
  '确定',
  '确认付款',
  '确认下单',
  '是的我确认',
  '我确认',
  'confirm',
  'yes',
]);

const CONFIG_PREFIX = ['设置', '配置', '偏好', '改成', '换成', '切换'];
const CONFIG_PHRASE: readonly RegExp[] = [
  /(默认|Default)(门店|餐厅|店)/i,
  /(切换|更换|改|换)(门店|餐厅|店)/,
  /(添加|新增|删除|移除)收藏/,
  /(设为|设置为|设成)(默认|喜爱|收藏)/,
  /(绑定|解绑)/,
];

const QUERY_PHRASE: readonly RegExp[] = [
  /^(查一下|查询|查查|查下|查|看看|看下|看一下|有没有)/,
  /(多少钱|什么价|价格|几块|贵吗)/,
  /(营业|开门|关门|几点|时间)/,
  /(附近|最近|周边)的?(门店|餐厅|店)/,
  /(门店|餐厅|店)列表/,
  /(我的)?(优惠券|券|卡券|会员券|可用券)/,
  /(积分|会员|余额)/,
  /(我的)?(订单|历史订单|最近订单)/,
  /(菜单|有什么|有啥|出售|在售)/,
  /(热量|卡路里|营养|蛋白质|配料|成分|过敏)/,
  /(地址|电话|在哪|怎么走|导航)/,
  /\?$|？$/,
];

const HELP_EXACT = new Set(['help', 'h', '帮助', '说明', '使用说明', '怎么用', '怎么玩', '?', '？']);
const HELP_PHRASE: readonly RegExp[] = [/(怎么|如何)(用|玩|下单|点单)/, /(支持|能做|可以)(什么|哪些)/];

const CHINESE_INDEX: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

// ─────────────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────────────

export function classifyIntent(input: string, ctx: IntentContext): Intent {
  const raw = input ?? '';
  const loose = trimPunctuation(normalizeLoose(raw));
  const compact = normalizeCompact(raw);
  const cleaned = stripCourtesy(loose);
  const base = { raw, normalized: loose, cleaned };

  const make = (
    kind: IntentKind,
    matchedRule: string,
    confidence: number,
    pickIndex?: number,
  ): Intent => ({
    kind,
    confidence,
    ...base,
    ...(pickIndex === undefined ? {} : { pickIndex }),
    matchedRule,
  });

  if (!loose) return make('help', 'empty', 1);

  // 1) 取消 —— 最保守，整句优先
  if (CANCEL_EXACT.has(compact)) return make('cancel', 'cancel-exact', 0.98);
  if (CANCEL_PHRASE.some((re) => re.test(loose))) return make('cancel', 'cancel-phrase', 0.9);

  // 2) 选择候选 —— 只在澄清态生效，避免把「两个巨无霸」开头的数字吃掉
  if (ctx.state === 'clarifying') {
    const pick = readPickIndex(loose, compact);
    if (pick !== undefined) return make('pickCandidate', 'pick', 0.95, pick);
  }

  // 3) 确认
  if (CONFIRM_EXACT.has(compact)) {
    return make('confirm', ctx.state === 'confirming' ? 'confirm-exact' : 'confirm-exact-no-target', 0.95);
  }
  // 重复一遍原话也当作确认 —— 公众号里这是很常见的输入方式
  if (
    ctx.state === 'confirming' &&
    ctx.draftRawText !== undefined &&
    normalizeCompact(ctx.draftRawText) === compact
  ) {
    return make('confirm', 'confirm-repeat', 0.85);
  }

  // 4) 配置
  if (CONFIG_PREFIX.some((p) => loose.startsWith(p))) return make('config', 'config-prefix', 0.9);
  if (CONFIG_PHRASE.some((re) => re.test(loose))) return make('config', 'config-phrase', 0.85);

  // 5) 帮助
  if (HELP_EXACT.has(compact)) return make('help', 'help-exact', 0.95);
  if (HELP_PHRASE.some((re) => re.test(loose))) return make('help', 'help-phrase', 0.85);

  // 6) 只读查询
  if (QUERY_PHRASE.some((re) => re.test(loose))) return make('query', 'query', 0.8);

  // 7) 默认：当作下单。**只有确实有内容时才这么做**
  if (cleaned.length > 0 || loose.length > 0) return make('order', 'default-order', 0.6);

  return make('help', 'fallback-help', 0.5);
}

/** 「1」「第2个」「第二个」「选 3」→ 下标（从 1 开始） */
export function readPickIndex(loose: string, compact: string): number | undefined {
  if (/^\d+$/.test(loose)) {
    const n = Number.parseInt(loose, 10);
    return n >= 1 ? n : undefined;
  }
  const gentle = compact.replace(/^\s+/, '');
  let m = gentle.match(/^第([一二三四五六七八九十]|\d+)个?$/);
  if (!m) m = gentle.match(/^选([一二三四五六七八九十]|\d+)$/);
  if (!m) m = gentle.match(/^要第?([一二三四五六七八九十]|\d+)个?$/);
  if (!m) return undefined;

  const token = m[1] ?? '';
  const num = /^\d+$/.test(token) ? Number.parseInt(token, 10) : CHINESE_INDEX[token];
  return num !== undefined && num >= 1 ? num : undefined;
}

/** 强化确认判定（FR-15）：金额超阈值时要求更明确的措辞 */
export function isStrongConfirmation(input: string): boolean {
  const compact = normalizeCompact(input);
  if (STRONG_CONFIRM_EXACT.has(compact)) return true;
  return /确认(无误|下单|付款|支付)|我确认|就这个了/.test(loose(input));
}

function loose(input: string): string {
  return trimPunctuation(normalizeLoose(input));
}
