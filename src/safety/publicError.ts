/** Stable user-facing error wording. Provider details stay out of replies. */

export interface ErrorSignals {
  readonly authFailed?: unknown;
  readonly ambiguous?: unknown;
  readonly httpStatus?: unknown;
  readonly code?: unknown;
}

export function publicErrorMessage(error: unknown, fallback = '服务暂时不可用，请稍后再试。'): string {
  const signals = error as ErrorSignals;
  if (signals.authFailed === true || signals.httpStatus === 401 || signals.httpStatus === 403) {
    return '登录信息已失效，请重新配置 Token 后再试。';
  }
  if (signals.ambiguous === true || signals.code === 'ETIMEDOUT' || signals.code === 'UND_ERR_CONNECT_TIMEOUT') {
    return '请求超时，订单状态需要到官方渠道核对。';
  }
  if (signals.httpStatus === 429) return '服务繁忙，请稍后再试。';
  return fallback;
}

export function internalErrorLabel(error: unknown): string {
  const name = error instanceof Error && error.name ? error.name : 'UnknownError';
  return name.slice(0, 64);
}
