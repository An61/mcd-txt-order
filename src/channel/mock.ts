/**
 * 网页版模拟器（T20 / FR-22）。
 *
 * 存在意义：**评审者 clone 下来、没有 Token、没有公众号，也要能完整玩一遍。**
 * 这是 Star 策略 Tier 0 的载体 —— 别人点进仓库第一眼看到的就是这一页。
 *
 * 所以它必须是单文件、零构建、零外部资源（不引 CDN、不引字体），
 * 断网也能打开。样式与脚本全部内联。
 */

/** 返回完整 HTML。刻意不依赖任何运行时状态，方便直接单测「能否渲染」 */
export function renderMockPage(initialMode: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>麦麦快捷点单 · 网页模拟器</title>
<style>
  :root {
    --bg: #f7f5f2;
    --card: #ffffff;
    --line: #e6e1da;
    --ink: #1f1b16;
    --muted: #7b7268;
    --brand: #da291c;
    --brand-soft: #fdecea;
    --gold: #ffc72c;
    --ok: #1a7f37;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif;
  }
  .wrap { max-width: 760px; margin: 0 auto; padding: 24px 16px 96px; }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
  .logo {
    width: 38px; height: 38px; border-radius: 10px; background: var(--brand);
    color: #fff; font-weight: 700; font-size: 20px;
    display: flex; align-items: center; justify-content: center;
  }
  h1 { font-size: 19px; margin: 0; letter-spacing: .3px; }
  .sub { color: var(--muted); font-size: 13px; margin: 0 0 16px 51px; }
  .banner {
    background: var(--brand-soft); border: 1px solid #f6cfcb; color: #8f2a20;
    border-radius: 10px; padding: 10px 12px; font-size: 13px; margin-bottom: 14px;
  }
  .chat {
    background: var(--card); border: 1px solid var(--line); border-radius: 14px;
    padding: 14px; min-height: 320px; max-height: 58vh; overflow-y: auto;
    display: flex; flex-direction: column; gap: 12px;
  }
  .row { display: flex; gap: 8px; }
  .row.me { justify-content: flex-end; }
  .bubble {
    max-width: 78%; padding: 10px 13px; border-radius: 12px; white-space: pre-wrap;
    word-break: break-word; font-size: 14px;
  }
  .row.you .bubble { background: #f1ede8; border-top-left-radius: 4px; }
  .row.me .bubble { background: var(--brand); color: #fff; border-top-right-radius: 4px; }
  .row.you .bubble.ok { background: #e8f5ec; color: var(--ok); }
  .tag { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 10px; }
  .chip {
    border: 1px solid var(--line); background: #fff; color: var(--ink);
    border-radius: 999px; padding: 6px 12px; font-size: 13px; cursor: pointer;
  }
  .chip:hover { border-color: var(--brand); color: var(--brand); }
  .bar { display: flex; gap: 8px; position: sticky; bottom: 0; background: var(--bg); padding-top: 10px; }
  input {
    flex: 1; padding: 11px 14px; border: 1px solid var(--line); border-radius: 10px;
    font-size: 15px; background: #fff; color: var(--ink);
  }
  input:focus { outline: 2px solid var(--gold); border-color: var(--gold); }
  button.send {
    padding: 11px 20px; border: 0; border-radius: 10px; background: var(--brand);
    color: #fff; font-size: 15px; cursor: pointer; font-weight: 600;
  }
  button.send:disabled { opacity: .5; cursor: default; }
  .hint { color: var(--muted); font-size: 12px; margin-top: 10px; }
  code { background: #f1ede8; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">M</div>
    <div>
      <h1>麦麦快捷点单 · 网页模拟器</h1>
      <div class="sub">一句话找店、匹配餐品、算真实价格 —— 回复「确认」才会真的下单</div>
    </div>
  </header>

  <div class="banner" id="banner">当前模式：<b>${escapeHtml(initialMode)}</b></div>

  <div class="chat" id="chat"></div>

  <div class="chips" id="chips"></div>

  <div class="bar">
    <input id="input" placeholder="试试：巨无霸不要酸黄瓜 香梅北" autocomplete="off">
    <button class="send" id="send">发送</button>
  </div>

  <div class="hint">
    这是本地模拟器，与微信公众号共用同一套会话核心 <code>ConversationCore</code>。
    每次刷新会生成新的用户 ID，因此会话状态不跨刷新保留。
  </div>
</div>

<script>
  var chat = document.getElementById('chat');
  var input = document.getElementById('input');
  var sendBtn = document.getElementById('send');
  var userId = 'web-' + Math.random().toString(36).slice(2, 10);

  var PRESETS = ['巨无霸 香梅北', '两个巨无霸一杯可乐 香梅北', '巨无霸不要酸黄瓜 香梅北', '确认', '算了', '帮助'];
  var chips = document.getElementById('chips');
  PRESETS.forEach(function (text) {
    var b = document.createElement('button');
    b.className = 'chip';
    b.textContent = text;
    b.onclick = function () { input.value = text; input.focus(); };
    chips.appendChild(b);
  });

  function addRow(who, text, tag) {
    var row = document.createElement('div');
    row.className = 'row ' + who;
    var b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = text;
    if (tag) { b.className += ' ok'; }
    row.appendChild(b);
    chat.appendChild(row);
    if (tag) {
      var t = document.createElement('div');
      t.className = 'tag';
      t.textContent = tag;
      row.appendChild(t);
    }
    chat.scrollTop = chat.scrollHeight;
  }

  function setBusy(busy) {
    sendBtn.disabled = busy;
    sendBtn.textContent = busy ? '处理中' : '发送';
  }

  async function send() {
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    addRow('me', text);
    setBusy(true);
    try {
      var res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: userId, text: text })
      });
      var data = await res.json();
      var tag = data.kind === 'placed' ? ('订单号 ' + (data.orderId || '')) : '';
      addRow('you', data.text || '(无回复)', tag);
      if (data.payUrl) {
        var a = document.createElement('div');
        a.className = 'tag';
        a.innerHTML = '<a href="' + data.payUrl + '" target="_blank" rel="noopener">打开支付链接</a>';
        chat.lastChild.appendChild(a);
      }
    } catch (e) {
      addRow('you', '请求失败：' + e);
    } finally {
      setBusy(false);
      input.focus();
    }
  }

  sendBtn.onclick = send;
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });
  addRow('you', '说一句想吃的就行，例如「巨无霸 香梅北」。\\n不确定先点上面任意一条试试。');
  input.focus();
</script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
