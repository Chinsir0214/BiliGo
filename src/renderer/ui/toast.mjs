export function createToast(element) {
  let timer;

  function show(message) {
    clearTimeout(timer);
    element.textContent = message;
    element.classList.add('show');
    timer = setTimeout(() => element.classList.remove('show'), 2800);
  }

  return show;
}
