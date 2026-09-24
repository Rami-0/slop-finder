const SVG_NS = 'http://www.w3.org/2000/svg';

export const $ = (selector, root = document) => root.querySelector(selector);

export function icon(name, className = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function setIcon(svg, name) {
  svg.querySelector('use').setAttribute('href', `#i-${name}`);
}

export function element(tag, { className, text, title, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  if (title) node.title = title;
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value != null && value !== false) node.setAttribute(name, value === true ? '' : value);
  }
  node.append(...children.filter(Boolean));
  return node;
}

export function badge(text, tone = '', iconName = null) {
  const node = element('span', { className: `badge${tone ? ` badge-${tone}` : ''}${iconName ? ' badge-icon' : ''}` });
  if (iconName) node.append(icon(iconName));
  node.append(text);
  return node;
}

export function button(text, { className = 'row-action', title, disabled, onClick } = {}) {
  const node = element('button', { className, text, title, attrs: { type: 'button', disabled: Boolean(disabled) } });
  if (onClick) node.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick(event);
  });
  return node;
}
