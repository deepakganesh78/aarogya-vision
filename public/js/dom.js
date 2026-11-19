// Minimal DOM builder. Text is always set via textContent, so user or server data is never parsed as HTML.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'className') node.className = value;
    else if (key in node && (typeof value !== 'string' || /[A-Z]/.test(key))) node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const LOCALES = { en: 'en-IN', hi: 'hi-IN', ta: 'ta-IN' };

// Like replaceChildren/append, but skips null/false (DOM methods would render them as the text "null").
export function setChildren(node, ...children) {
  node.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

export function appendChildren(node, ...children) {
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

export function formatDate(iso, lang = 'en') {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(LOCALES[lang] || 'en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}
