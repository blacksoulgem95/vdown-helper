// ?lang=it shows the demo page in Italian (for the Italian store images): every element with data-it swaps its text,
// and <html data-it-title> replaces the title (the extension shows it as the page and card title).
if (new URLSearchParams(location.search).get('lang') === 'it') {
  document.documentElement.lang = 'it';
  const title = document.documentElement.dataset.itTitle;
  if (title) document.title = title;
  for (const el of document.querySelectorAll('[data-it]')) el.textContent = el.dataset.it;
  for (const el of document.querySelectorAll('[data-it-attr-title]')) el.title = el.dataset.itAttrTitle;
}
