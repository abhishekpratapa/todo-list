// Small, safe Markdown renderer for notes and comments. Input is HTML-escaped
// before anything else, only a fixed set of tags is ever emitted, and links are
// limited to http(s) and mailto. Covers what todo notes need: headings, bold,
// italic, strikethrough, code, links, lists, task lists, quotes, rules.

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const link = (url, text) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;

// A bare URL runs to the next whitespace or escaped quote/bracket.
const BARE_URL = /(^|[\s(])(https?:\/\/(?:(?!&(?:lt|gt|quot|#39);)\S)+)/g;

// Inline formatting for one line of raw text.
export function inline(src) {
  const stash = []; // finished HTML, kept out of the way of later replacements
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  let s = esc(String(src ?? '').replace(/\u0000/g, ''));

  s = s.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${code}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (_, text, url) => keep(link(url, text)));
  s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_, url) => keep(link(url, url)));
  s = s.replace(BARE_URL, (_, pre, url) => {
    // Trailing punctuation belongs to the sentence, not the link.
    let tail = '';
    while (/[.,;:!?]$/.test(url) || (url.endsWith(')') && !url.includes('('))) {
      tail = url.slice(-1) + tail;
      url = url.slice(0, -1);
    }
    return pre + keep(link(url, url)) + tail;
  });

  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*([^*\s][^*\n]*)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w_])_([^_\s][^_\n]*)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[i]);
}

const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
const FENCE = /^\s*```/;

function listItem(text) {
  const task = text.match(/^\[([ xX])\]\s+(.*)$/);
  if (!task) return `<li>${inline(text)}</li>`;
  const done = task[1] !== ' ';
  return `<li class="task${done ? ' done' : ''}"><input type="checkbox" disabled${done ? ' checked' : ''}>${inline(task[2])}</li>`;
}

// Block-level rendering for a whole note.
export function render(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;

    if (FENCE.test(line)) {
      flush();
      const code = [];
      while (++i < lines.length && !FENCE.test(lines[i])) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    } else if (!line.trim()) {
      flush();
    } else if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flush();
      out.push(`<h${m[1].length + 2}>${inline(m[2])}</h${m[1].length + 2}>`);
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      out.push('<hr>');
    } else if (/^\s*>/.test(line)) {
      flush();
      const quote = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''));
      i--;
      out.push(`<blockquote>${quote.map(inline).join('<br>')}</blockquote>`);
    } else if (UL.test(line) || OL.test(line)) {
      flush();
      const re = UL.test(line) ? UL : OL;
      const items = [];
      for (; i < lines.length && (m = lines[i].match(re)); i++) items.push(listItem(m[1]));
      i--;
      const tag = re === UL ? 'ul' : 'ol';
      out.push(`<${tag}>${items.join('')}</${tag}>`);
    } else {
      para.push(line);
    }
  }
  flush();
  return out.join('');
}
