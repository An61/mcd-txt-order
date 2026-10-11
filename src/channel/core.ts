/**
 * 渠道无关的会话核心（T19）。
 *
 * 输入一串文本，输出一串文本。不含任何微信字段、不含 process.stdout ——
 * 终端模拟器、微信公众号、网页 demo 共用同一个 {@link ConversationCore}，
 * 这是 Star 策略 Tier 0 能成立的前提：**不用公众号也能体验完整流程**。
 *
 * 这里是「⟪钱⟫」唯一可能被花出去的地方，因此它也是所有安全闸汇合的地方：
 *   意图 → 会话状态 → 确认令牌 → 守卫 → 网关写调用
 * 四道关任何一道不通过，都到不了 create-order。
 */

import { ConfirmationService } from '../safety/confirmation.ts';
import { OrderGuard, type GuardPolicy } from '../safety/guard.ts';
import { SessionStore, canPlaceOrder, type Session, type SessionDraft } from '../domain/session.ts';
import {
  classifyIntent,
  isStrongConfirmation,
  type IntentKind,
} from '../domain/intent.ts';
import { buildPreview, renderPreview, type FlowResult } from '../domain/orderFlow.ts';
import {
  defaultCity as resolveDefaultCity,
  loadFavorites,
  type FavoritesConfig,
} from '../domain/favorites.ts';
import { money, type SceneKey, type Store } from '../domain/types.ts';
import { createGateway, describeScenes, type GatewayBundle, type DataGateway } from '../mcp/gateway.ts';
import { createProductionOrderAttemptStore } from '../safety/orderAttemptStore.ts';
import { internalErrorLabel, publicErrorMessage } from '../safety/publicError.ts';

export type ReplyKind =
  | 'help'
  | 'need-info'
  | 'clarify'
  | 'preview'
  | 'placed'
  | 'cancelled'
  | 'reply'
  | 'error';

export interface CoreReply {
  readonly text: string;
  readonly kind: ReplyKind;
  /** 结构化信息，渠道层可据此渲染卡片 */
  readonly payUrl?: string;
  readonly orderId?: string;
}

export interface CoreOptions {
  readonly gateway?: DataGateway;
  readonly bundle?: GatewayBundle;
  readonly favorites?: FavoritesConfig;
  readonly sessions?: SessionStore;
  readonly confirmations?: ConfirmationService;
  readonly guard?: OrderGuard;
}

const HELP_TEXT = [
  '🍔 一句话点麦当劳',
  '',
  '直接说想要的就行，例如：',
  '· 巨无霸 香梅北',
  '· 两个巨无霸一杯可乐 香梅北',
  '· 巨无霸不要酸黄瓜 香梅北',
  '',
  '它会自动找店、找菜、算真实价格，',
  '给你一张预览卡片。**回复「确认」才会真的下单。**',
  '',
  '其它：1/第一个=选候选｜算了=取消｜帮助=看这段',
].join('\n');

export class ConversationCore {
  readonly gateway: DataGateway;
  readonly favorites: FavoritesConfig;

  private readonly bundleReason: string;
  private readonly sessions: SessionStore;
  private readonly confirmations: ConfirmationService;
  private readonly guard: OrderGuard;

  constructor(options: CoreOptions = {}) {
    const bundle = options.bundle ?? createGateway();
    this.gateway = options.gateway ?? bundle.gateway;
    this.bundleReason = bundle.reason;
    this.favorites = options.favorites ?? loadFavorites().config;
    this.sessions = options.sessions ?? new SessionStore();
    this.confirmations = options.confirmations ?? new ConfirmationService();
    this.guard = options.guard ?? new OrderGuard({
      store: this.gateway.mode === 'real' ? createProductionOrderAttemptStore() : undefined,
    });
  }

  /** 演示模式下每条回复都要挂标识，防止用户误以为已经真的下单了 */
  private get modeBanner(): string {
    return this.gateway.mode === 'sample' ? `\n\n${this.gateway.describe()}` : '';
  }

  async handle(userId: string, text: string): Promise<CoreReply> {
    const session = this.sessions.touch(userId);

    try {
      return await this.dispatch(userId, text, session);
    } catch (error) {
      // FR-19：任何异常都不能把 JSON 技术细节抛给用户
      this.sessions.markError(userId, internalErrorLabel(error));
      return {
        kind: 'error',
        text: `出了点问题：${friendlyError(error)}${this.modeBanner}`,
      };
    }
  }

  private async dispatch(userId: string, text: string, session: Session): Promise<CoreReply> {
    const intent = classifyIntent(text, {
      state: session.state,
      draftRawText: session.draft?.rawText,
      candidateCount: session.draft?.candidates?.length,
    });

    switch (intent.kind) {
      case 'help':
        return { kind: 'help', text: HELP_TEXT + this.modeBanner };

      case 'cancel':
        return this.cancel(userId);

      case 'pickCandidate':
        return this.pick(userId, intent.pickIndex);

      case 'confirm':
        return this.place(userId, intent.kind === 'confirm', isStrongConfirmation(text));

      case 'config':
        return {
          kind: 'reply',
          text:
            '改收藏请编辑 config/favorites.json（可从 favorites.example.json 复制）。\n' +
            '门店/餐品别名、默认数量、默认特制都在那里配置。',
        };

      case 'query':
        return this.query(userId, intent.normalized);

      case 'order':
      default:
        return this.startOrder(userId, text, intent.kind === 'order');
    }
  }

  // ── 下单 ──────────────────────────────────────────────────

  private async startOrder(userId: string, rawText: string, confident: boolean): Promise<CoreReply> {
    const scene = (this.favorites.rules.defaultScene ?? 'pickup') as SceneKey;
    const result = await buildPreview({
      gateway: this.gateway,
      favorites: this.favorites,
      rawText,
      scene,
    });

    if (!result.ok) return this.fromFailure(userId, result, confident);

    const ticket = this.confirmations.issue({ userId, cart: result.preview.cart });
    const transition = this.sessions.toConfirming(userId, result.preview, ticket.token);
    if (!transition.ok) {
      return { kind: 'error', text: `状态异常：${transition.message}${this.modeBanner}` };
    }

    const card = renderPreview(result.preview, result.notes);
    return { kind: 'preview', text: card + this.modeBanner };
  }

  private fromFailure(userId: string, result: FlowResult, _confident: boolean): CoreReply {
    if (result.ok) return { kind: 'reply', text: '' };

    if (result.reason === 'ambiguous-item' && result.candidates?.length) {
      const draft: SessionDraft = {
        rawText: '',
        specs: [],
        candidates: result.candidates.map((label) => ({ label, value: label })),
      };
      const listed = result.candidates.map((name, index) => `${index + 1}. ${name}`).join('\n');
      this.sessions.toClarifying(userId, draft);
      return { kind: 'clarify', text: `${result.message}\n${listed}` };
    }

    // 其余失败都回到空闲态，避免留下能继续推进的半截状态
    this.sessions.toIdle(userId);
    return { kind: result.reason === 'need-store' || result.reason === 'need-item' ? 'need-info' : 'error', text: result.message + this.modeBanner };
  }

  private async pick(userId: string, index: number | undefined): Promise<CoreReply> {
    const session = this.sessions.get(userId);
    const candidates = session.draft?.candidates ?? [];
    if (candidates.length === 0) {
      return { kind: 'reply', text: '现在没有待选的东西哦。' };
    }
    if (index === undefined || index < 1 || index > candidates.length) {
      const listed = candidates.map((c, i) => `${i + 1}. ${c.label}`).join('\n');
      return { kind: 'clarify', text: `请回复 1~${candidates.length} 之间的序号：\n${listed}` };
    }

    const chosen = candidates[index - 1]?.value;
    if (typeof chosen !== 'string') return { kind: 'error', text: '候选项异常，请重新发起。' };

    // 用选中的官方品名重建预览，避免"选了 2 又回去重新猜一次"
    const rawText = session.draft?.rawText ?? '';
    const scene = (this.favorites.rules.defaultScene ?? 'pickup') as SceneKey;
    const result = await buildPreview({
      gateway: this.gateway,
      favorites: this.favorites,
      rawText: rawText || chosen,
      scene,
      pinnedItemName: chosen,
      ...(session.cart?.store.code ? { pinnedStoreCode: session.cart.store.code } : {}),
    });

    if (!result.ok) return this.fromFailure(userId, result, true);

    const ticket = this.confirmations.issue({ userId, cart: result.preview.cart });
    this.sessions.toConfirming(userId, result.preview, ticket.token);
    return { kind: 'preview', text: renderPreview(result.preview, result.notes) + this.modeBanner };
  }

  // ── 真正下单的地方 ─────────────────────────────────────────

  private async place(userId: string, isConfirmIntent: boolean, strong: boolean): Promise<CoreReply> {
    const session = this.sessions.get(userId);

    if (!isConfirmIntent || !canPlaceOrder(session) || !session.preview) {
      return {
        kind: 'reply',
        text: session.state === 'idle'
          ? '现在没有待确认的订单，先说想要吃什么吧。'
          : '这一步还需要你明确回复「确认」才会下单。',
      };
    }

    const preview = session.preview;
    const token = session.confirmToken;

    // ① 令牌：一次性、绑定本人与本购物车
    const verified = token
      ? this.confirmations.consume(token, userId, preview.fingerprint)
      : { ok: false as const, reason: 'unknown-token' as const, message: '确认信息已失效，请重新发起点单。' };
    if (!verified.ok) {
      this.sessions.toIdle(userId);
      return { kind: 'error', text: verified.message };
    }

    // ② 守卫：幂等 + 冷却 + 限次限额
    const strongOk = session.strongConfirmed === true || strong;
    const verdict = this.guard.evaluate({
      userId,
      cart: preview.cart,
      payableCents: preview.price.payableCents,
      strongConfirmed: strongOk,
    });

    if (verdict.kind === 'needs-strong-confirm') {
      this.sessions.patch(userId, { strongConfirmed: true });
      // 注意：令牌已被消费，这里重新签发一张，让用户还能完成这次确认
      const again = this.confirmations.issue({ userId, cart: preview.cart });
      this.sessions.patch(userId, { confirmToken: again.token });
      return { kind: 'preview', text: verdict.message };
    }

    if (verdict.kind === 'blocked') {
      this.sessions.toIdle(userId);
      return { kind: 'reply', text: verdict.message };
    }

    const acquired = this.guard.begin({
      userId,
      cart: preview.cart,
      payableCents: preview.price.payableCents,
      strongConfirmed: strongOk,
    });
    if (!acquired.acquired) {
      this.sessions.toIdle(userId);
      return {
        kind: 'reply',
        text: acquired.verdict.kind === 'blocked' ? acquired.verdict.message : '这笔订单已经处理过了。',
      };
    }

    // ③ 真正花钱的一步
    try {
      const order = await this.gateway.createOrder({
        cart: preview.cart,
        takeWayCode: preview.takeWay.code,
      });
      this.guard.succeed(userId, preview.cart, order.orderId, preview.price.payableCents);
      this.sessions.toPlaced(userId, order.orderId, preview.cart.store.code);

      return {
        kind: 'placed',
        orderId: order.orderId,
        ...(order.payUrl ? { payUrl: order.payUrl } : {}),
        text:
          `✅ 订单已创建：${order.orderId}\n` +
          `应付 ${money(preview.price.payableCents)}\n` +
          `${order.expireText ? `(${order.expireText})\n` : ''}` +
          (order.payUrl
            ? `👉 ${order.payUrl}\n\n`
            : '支付链接暂不可用，请在官方订单中核对。\n\n') +
          '支付链接只发给你本人，请勿转发。',
      };
    } catch (error) {
      // SEC-6：失败进终态，绝不自动重试。网络/超时结果未知时单独封存，
      // 这样重启或多实例回放不会把可能已经创建的订单再写一次。
      if (isAmbiguousOrderError(error)) this.guard.markUnknown(userId, preview.cart);
      else this.guard.fail(userId, preview.cart);
      if (isAuthFailure(error)) this.guard.markAuthFailed(userId);
      this.sessions.toIdle(userId);
      const failureText = isAmbiguousOrderError(error)
        ? '下单请求已发出但结果未知，请先到官方订单核对，不要重复确认或重新下单。'
        : `下单失败：${friendlyError(error)}\n没有扣款，也没有自动重试。确认后请重新发起一次点单。`;
      return {
        kind: 'error',
        text: failureText + this.modeBanner,
      };
    }
  }

  // ── 取消 / 只读查询 ────────────────────────────────────────

  private cancel(userId: string): CoreReply {
    const revoked = this.confirmations.revokeUser(userId);
    this.sessions.toIdle(userId);
    return {
      kind: 'cancelled',
      text: revoked > 0 ? '已取消，这笔没有下单。' : '当前没有待确认的订单。',
    };
  }

  private async query(userId: string, text: string): Promise<CoreReply> {
    const session = this.sessions.get(userId);
    if (/门店|哪家|附近/.test(text)) {
      const city = resolveDefaultCity(this.favorites);
      if (!city) {
        return { kind: 'need-info', text: '还不知道你在哪个城市，请先配置 rules.defaultCity。' };
      }
      try {
        const stores: Store[] = await this.gateway.listStores({
          scene: (this.favorites.rules.defaultScene ?? 'pickup') as SceneKey,
          city,
          keyword: '麦当劳',
        });
        if (stores.length === 0) return { kind: 'reply', text: `${city}附近没查到门店。` };
        const lines = stores.slice(0, 6).map((store, index) => {
          const distance = store.distanceMeters !== undefined ? `（约 ${store.distanceMeters}m）` : '';
          return `${index + 1}. ${store.name}${distance}`;
        });
        return {
          kind: 'reply',
          text: `${city}附近的门店：\n${lines.join('\n')}\n\n选好后可以说「巨无霸 ${stores[0]?.name ?? ''}」`,
        };
      } catch (error) {
        return { kind: 'error', text: `查门店失败：${friendlyError(error)}` };
      }
    }

    void session;
    return {
      kind: 'reply',
      text:
        '这一段还在建设中。目前能稳定做的事：找店、匹配餐品、算真实价格、确认后下单。\n' +
        `支持场景：${describeScenes()}`,
    };
  }
}

function friendlyError(error: unknown): string {
  return publicErrorMessage(error);
}

function isAuthFailure(error: unknown): boolean {
  const candidate = error as { readonly authFailed?: unknown; readonly httpStatus?: unknown };
  return candidate.authFailed === true || candidate.httpStatus === 401 || candidate.httpStatus === 403;
}

function isAmbiguousOrderError(error: unknown): boolean {
  const candidate = error as { readonly ambiguous?: unknown; readonly code?: unknown; readonly name?: unknown };
  if (candidate.ambiguous === true) return true;
  if (candidate.name === 'AbortError' || candidate.name === 'TimeoutError') return true;
  return candidate.code === 'ETIMEDOUT' || candidate.code === 'UND_ERR_CONNECT_TIMEOUT';
}
