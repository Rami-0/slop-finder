import { api } from './api.js';
import { $, element, icon } from './dom.js';
import { tildify } from './format.js';

// Extra delete locations live in this browser's localStorage, as chosen. The
// server re-validates every location on every request, so a stale or edited
// entry can only ever grant less, never more.
const STORAGE_KEY = 'slop-finder.extra-roots';
let memoryFallback = [];

export function getExtraRoots() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(stored) ? stored.filter((value) => typeof value === 'string') : [];
  } catch {
    return memoryFallback;
  }
}

function saveExtraRoots(roots) {
  memoryFallback = roots;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(roots));
    return true;
  } catch {
    return false;
  }
}

export function initLocations({ notify, onChange }) {
  const el = {
    popover: $('#locations-popover'),
    builtin: $('#builtin-locations'),
    extra: $('#extra-locations'),
    form: $('#location-form'),
    input: $('#location-input'),
    error: $('#location-error'),
    protectedSummary: $('#protected-summary')
  };
  let info = null;

  function renderList(list, paths, removable) {
    if (!paths.length) {
      list.replaceChildren(element('li', { className: 'is-empty', text: 'None yet. Add a drive or folder outside your home folder.' }));
      return;
    }
    list.replaceChildren(...paths.map((path) => {
      const item = element('li', { title: path }, [element('span', { text: tildify(path) })]);
      if (removable) {
        const remove = element('button', { className: 'icon-button', title: `Stop allowing ${path}`, attrs: { type: 'button' } }, [icon('close')]);
        remove.addEventListener('click', () => {
          saveExtraRoots(getExtraRoots().filter((root) => root !== path));
          render();
          onChange();
          notify(`Deletions no longer allowed in ${tildify(path)}`);
        });
        item.append(remove);
      }
      return item;
    }));
  }

  // Built-in locations are shown by name ($TMPDIR, not /private/var/folders/…/T),
  // since their paths differ from Mac to Mac. The real path is in the tooltip.
  function renderBuiltin() {
    el.builtin.replaceChildren(...info.builtin.map((location) => element('li', { className: 'is-builtin', title: location.path }, [
      element('span', { text: location.label }),
      element('small', { className: 'location-note', text: location.note })
    ])));
  }

  function render() {
    if (info) renderBuiltin();
    renderList(el.extra, getExtraRoots(), true);
  }

  async function ensureInfo() {
    if (info) return;
    try {
      info = await api.locations();
      el.protectedSummary.textContent = info.protectedSummary;
    } catch (error) {
      el.error.textContent = error.message;
    }
  }

  el.popover.addEventListener('toggle', async (event) => {
    if (event.newState !== 'open') return;
    el.error.textContent = '';
    await ensureInfo();
    render();
    el.input.focus();
  });

  el.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    el.error.textContent = '';
    try {
      const { path } = await api.validateLocation(el.input.value);
      const roots = getExtraRoots();
      if (!roots.includes(path)) {
        const persisted = saveExtraRoots([...roots, path]);
        if (!persisted) el.error.textContent = 'This browser blocks local storage, so this location resets when you reload.';
      }
      el.input.value = '';
      render();
      onChange();
      notify(`Deletions allowed in ${tildify(path)}`);
    } catch (error) {
      el.error.textContent = error.message;
    }
  });
}
