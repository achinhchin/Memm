/* Sign-in / sign-up screen. */
(() => {
const { el, $, esc } = M.ui, ic = M.icons;

M.auth = { mount(root, onDone) {
  let mode = 'login';
  const render = () => {
    root.className = 'app-boot';
    root.innerHTML = '';
    const isNew = mode === 'signup';
    const card = el('form', { class: 'auth glass', autocomplete: 'on' }, `
      <div class="auth-logo">${ic('memm', 21)}<span>Memm</span></div>
      <p class="sub">${isNew ? 'Start a journal that remembers when, not just what.' : 'Welcome back.'}</p>
      ${isNew ? `<div class="field"><label for="n">Name</label>
        <input class="input" id="n" name="name" autocomplete="name" placeholder="Optional"></div>` : ''}
      <div class="field"><label for="e">Email</label>
        <input class="input" id="e" name="email" type="email" required autocomplete="email" placeholder="you@example.com"></div>
      <div class="field"><label for="p">Password</label>
        <input class="input" id="p" name="password" type="password" required minlength="8"
          autocomplete="${isNew ? 'new-password' : 'current-password'}" placeholder="${isNew ? 'At least 8 characters' : '••••••••'}"></div>
      <div class="err" role="alert"></div>
      <button class="btn btn-primary" type="submit" style="justify-content:center">
        ${isNew ? 'Create account' : 'Sign in'}</button>
      <div class="switcher">${isNew ? 'Already have an account?' : "Don't have an account?"}
        <button type="button" id="sw">${isNew ? 'Sign in' : 'Sign up'}</button></div>`);

    $('#sw', card).onclick = () => { mode = isNew ? 'login' : 'signup'; render(); };

    card.onsubmit = async ev => {
      ev.preventDefault();
      const btn = card.querySelector('button[type=submit]');
      const err = card.querySelector('.err');
      err.textContent = ''; btn.disabled = true;
      const prev = btn.innerHTML;
      btn.innerHTML = '<span class="spin"></span>';
      const body = {
        email: card.email.value.trim(),
        password: card.password.value,
        name: card.name?.value.trim() || '',
        tzOffset: M.ui.localOffset(),
      };
      try {
        onDone(await (isNew ? M.api.signup(body) : M.api.login(body)));
      } catch (e) {
        err.textContent = e.message;
        btn.disabled = false; btn.innerHTML = prev;
        card.password.focus(); card.password.select();
      }
    };
    root.append(card);
  };
  render();
}};
})();
