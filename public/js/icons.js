import { ICON_PATHS } from '/vendor/icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgFor(name, filled) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 -960 960 960');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICON_PATHS[filled ? `${name}:fill` : name] || ICON_PATHS[name] || []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** Material Symbols (rounded) glyph inside an <md-icon>. */
export function icon(name, { filled = false, slot, className } = {}) {
  const node = document.createElement('md-icon');
  if (slot) node.slot = slot;
  if (className) node.className = className;
  node.dataset.icon = name;
  node.append(svgFor(name, filled));
  return node;
}

export function setIcon(node, name, { filled = false } = {}) {
  node.dataset.icon = name;
  node.replaceChildren(svgFor(name, filled));
}

/** Fill every static <md-icon data-icon="..."> in the document. */
export function hydrateIcons(root = document) {
  for (const node of root.querySelectorAll('md-icon[data-icon]')) {
    if (!node.firstElementChild) node.append(svgFor(node.dataset.icon, node.hasAttribute('data-filled')));
  }
}
