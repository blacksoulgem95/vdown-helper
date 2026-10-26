// Requests made inside a worker do not appear in the page's Performance timeline.
fetch('/hls/master.m3u8')
  .then((r) => r.text())
  .catch(() => {});
