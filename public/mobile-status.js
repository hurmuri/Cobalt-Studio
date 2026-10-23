// Keep a useful status even when an embedded browser cannot load module scripts.
setTimeout(function () {
  var status = document.getElementById('mobileBootStatus');
  if (!status || document.documentElement.dataset.connected === '1') return;
  status.textContent = '手机页面未能完成连接。请用 Safari、Chrome 或手机系统浏览器打开完整的 http 地址，确认与电脑在同一 Wi-Fi。';
  var retry = document.createElement('a');
  retry.href = '/mobile?retry=' + Date.now();
  retry.textContent = ' 重新加载';
  status.appendChild(retry);
}, 10000);
