// Sentinel Override — shared HTML sanitizer for the report pages.
// Plain (non-module) script loaded by report-print.html and report-view.html
// before their page scripts; defines the global `sanitizeHtml`.
// Strips <script> elements, on* event-handler attributes and javascript: URLs
// from rendered markdown before it is assigned to innerHTML.

// eslint-disable-next-line no-unused-vars
function sanitizeHtml(dirty) {
  if (!dirty) return '';
  var div = document.createElement('div');
  div.innerHTML = dirty;
  var scripts = div.querySelectorAll('script');
  for (let i = 0; i < scripts.length; i++) scripts[i].remove();
  var all = div.querySelectorAll('*');
  for (let i = 0; i < all.length; i++) {
    var el = all[i];
    var attrs = el.attributes;
    for (var j = attrs.length - 1; j >= 0; j--) {
      var name = attrs[j].name.toLowerCase();
      var value = attrs[j].value.toLowerCase();
      if (name.startsWith('on') || value.startsWith('javascript:')) {
        el.removeAttribute(attrs[j].name);
      }
    }
  }
  return div.innerHTML;
}
