export function initCustomSelect(wrapper, { select, multiple, emptyLabel, menuId, fieldLabel, closeOthers }) {
  const document = wrapper.ownerDocument;
  const button = wrapper.querySelector('.custom-select-button');
  const menu = wrapper.querySelector('.custom-select-menu');
  let label = button.querySelector('[data-label]');
  if (!label) {
    label = document.createElement('span');
    label.dataset.label = '';
    button.replaceChildren(label);
  }
  menu.id ||= menuId;
  menu.setAttribute('aria-label', fieldLabel);
  button.setAttribute('aria-controls', menu.id);
  if (multiple) menu.setAttribute('aria-multiselectable', 'true');

  const options = () => [...menu.querySelectorAll('.custom-select-option')];
  const selected = () => options().filter(item => item.classList.contains('selected'));

  function setOpen(open) {
    if (open && button.disabled) return;
    if (open) closeOthers(wrapper);
    wrapper.classList.toggle('open', open);
    button.setAttribute('aria-expanded', String(open));
  }

  let disabled = Boolean(select?.disabled);
  function setDisabled(value) {
    disabled = value;
    if (select) select.disabled = disabled;
    button.disabled = disabled || !menu.childElementCount;
    if (button.disabled) setOpen(false);
  }

  function sync() {
    if (select) {
      options().forEach(item => {
        const chosen = item.dataset.value === select.value;
        item.classList.toggle('selected', chosen);
        item.setAttribute('aria-selected', String(chosen));
      });
    }
    label.textContent = selected().map(item => item.textContent).join('、') || emptyLabel;
    button.setAttribute('aria-label', fieldLabel + '：' + label.textContent);
  }

  function render(values) {
    menu.replaceChildren(...values.map(value => {
      const item = document.createElement('button');
      item.type = 'button';
      item.tabIndex = -1;
      item.className = 'custom-select-option';
      item.dataset.value = String(value.value);
      item.textContent = String(value.label || value.value);
      item.setAttribute('role', 'option');
      item.classList.toggle('selected', value.selected === true);
      item.setAttribute('aria-selected', String(value.selected === true));
      return item;
    }));
    setDisabled(disabled);
    sync();
  }

  menu.addEventListener('click', event => {
    const item = event.target.closest('.custom-select-option');
    if (!item || button.disabled) return;
    event.stopPropagation();
    if (multiple) {
      item.classList.toggle('selected');
      item.setAttribute('aria-selected', String(item.classList.contains('selected')));
    } else {
      select.value = item.dataset.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      setOpen(false);
      button.focus();
    }
    sync();
  });

  button.addEventListener('click', event => {
    event.stopPropagation();
    const open = !wrapper.classList.contains('open');
    setOpen(open);
    if (open) (selected()[0] || options()[0])?.focus();
  });
  button.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      const items = options();
      (selected()[0] || items[event.key === 'ArrowDown' ? 0 : items.length - 1])?.focus();
    } else if (event.key === 'Escape') setOpen(false);
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      button.focus();
      return;
    }
    const items = options();
    const current = items.indexOf(document.activeElement);
    const next = { ArrowDown: current + 1, ArrowUp: current - 1, Home: 0, End: items.length - 1 }[event.key];
    if (next !== undefined) {
      event.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, next))]?.focus();
    }
  });
  wrapper.addEventListener('focusout', event => {
    if (!wrapper.contains(event.relatedTarget)) setOpen(false);
  });
  return { render, sync, setDisabled, values: () => selected().map(item => item.dataset.value) };
}

export function createSelects({ $, document }) {
  let nextId = 0;
  let subtitlePicker;
  function closeOthers(except) {
    document.querySelectorAll('.custom-select.open').forEach(wrapper => {
      if (wrapper === except) return;
      wrapper.classList.remove('open');
      wrapper.querySelector('.custom-select-button').setAttribute('aria-expanded', 'false');
    });
  }

  function setup(panel) {
    panel.querySelectorAll('select').forEach(select => {
      if (select.customControl) return;
      const wrapper = document.createElement('div');
      wrapper.className = 'custom-select';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'custom-select-button';
      button.setAttribute('aria-haspopup', 'listbox');
      button.setAttribute('aria-expanded', 'false');
      const menu = document.createElement('div');
      menu.className = 'custom-select-menu';
      menu.setAttribute('role', 'listbox');
      wrapper.append(button, menu);
      select.before(wrapper);
      select.hidden = true;
      const fieldLabel = select.closest('label').querySelector(':scope > [data-label]').textContent.trim();
      const control = initCustomSelect(wrapper, {
        select, multiple: false, emptyLabel: '', fieldLabel, closeOthers, menuId: 'custom-select-menu-' + ++nextId
      });
      control.render([...select.options].map(option => ({ value: option.value, label: option.textContent, selected: option.selected })));
      select.customControl = control;
    });
  }

  function bind() {
    const field = $('#subtitlePicker');
    const control = initCustomSelect(field.querySelector('.custom-select'), {
      select: null, multiple: true, emptyLabel: '未选择字幕', closeOthers,
      fieldLabel: field.querySelector(':scope > [data-label]').textContent.trim(),
      menuId: 'custom-select-menu-' + ++nextId
    });
    control.render([]);
    subtitlePicker = {
      refresh: values => control.render(values.map(value => ({ ...value, selected: true }))),
      values: control.values,
      setVisible: visible => field.classList.toggle('hidden', !visible)
    };
    setup($('#downloadView'));
    document.addEventListener('click', event => {
      if (!event.target.closest('.custom-select')) closeOthers(null);
    });
  }

  return { bind, setup, get subtitlePicker() { return subtitlePicker; } };
}
