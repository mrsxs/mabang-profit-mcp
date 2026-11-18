// 弹窗：连接状态、「常开马帮页」开关、「现在打开」按钮。页面上的文字一律 textContent。
const $ = (id) => document.getElementById(id);
const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s} 秒前` : `${Math.round(s / 60)} 分钟前`;
};

function show(id, st, okText, badText) {
  const el = $(id);
  if (!st) {
    el.textContent = '未打开';
    el.className = 'muted';
    return;
  }
  el.textContent = st.ok ? `${okText}（${ago(st.at)}）` : badText;
  el.className = st.ok ? 'ok' : 'bad';
  if (!st.ok && st.error) el.title = st.error;
}

async function refresh() {
  const { status = {} } = await chrome.storage.session.get('status');
  // 中转每 20 秒轮询一次：超过 1 分钟没连上就算断开
  const hub = status.hub && { ...status.hub, ok: status.hub.ok && Date.now() - status.hub.at < 60_000 };
  show('hub', hub, '已连接', '没连上（Accio 没开？）');
  show('finance', status.finance, '就绪', '打不开');
  show('stock', status.stock, '就绪', '打不开');
  show('order', status.order, '就绪', '打不开');
}

(async () => {
  const { alwaysOn } = await chrome.storage.local.get('alwaysOn');
  $('always-on').checked = alwaysOn !== false;
  $('always-on').addEventListener('change', async (e) => {
    await chrome.storage.local.set({ alwaysOn: e.target.checked });
    $('msg').textContent = e.target.checked ? '马帮页会在后台一直开着' : '已取消常开，马帮页闲置 10 分钟后关掉';
  });
  $('open-now').addEventListener('click', async () => {
    $('msg').textContent = '正在打开…';
    const r = await chrome.runtime.sendMessage({ type: 'openNow' });
    $('msg').textContent = r?.errors?.length ? r.errors.join('；') : '马帮页已就绪';
    refresh();
  });
  refresh();
  setInterval(refresh, 2000);
})();
