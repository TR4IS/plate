import { html, useState } from '../lib.js';
import { errorText, login, setupOwner, signup, useStore } from '../store.js';
import { Field, Icon, Spinner } from '../ui.js';

function PasswordInput({ value, onInput, isNew }) {
  const [visible, setVisible] = useState(false);
  return html`<div class="input-wrap">
    <input
      class="input"
      type=${visible ? 'text' : 'password'}
      name="password"
      autocomplete=${isNew ? 'new-password' : 'current-password'}
      autocapitalize="none"
      spellcheck="false"
      placeholder=${isNew ? 'At least 8 characters' : 'Password'}
      value=${value}
      onInput=${(event) => onInput(event.target.value)}
    />
    <button type="button" class="icon-btn" aria-label=${visible ? 'Hide password' : 'Show password'} onClick=${() => setVisible(!visible)}>
      <${Icon} name=${visible ? 'eyeOff' : 'eye'} size="20" />
    </button>
  </div>`;
}

const COPY = {
  setup: {
    title: 'Welcome to Plate',
    text: 'Create the owner account for this server. You can invite other people afterwards.',
    button: 'Create account',
  },
  login: { title: 'Welcome back', text: 'Sign in to pick up where you left off.', button: 'Sign in' },
  signup: { title: 'Join Plate', text: 'Use the invite code the owner gave you.', button: 'Create account' },
};

export function AuthView() {
  const { needsSetup } = useStore();
  const [wantsSignup, setWantsSignup] = useState(false);
  const mode = needsSetup ? 'setup' : wantsSignup ? 'signup' : 'login';
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const copy = COPY[mode];

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (name.trim().length < 2) return setError('Enter your name.');
    if (mode !== 'login' && password.length < 8) return setError('Use a password with at least 8 characters.');
    setBusy(true);
    try {
      if (mode === 'setup') await setupOwner(name, password);
      else if (mode === 'signup') await signup(name, password, code);
      else await login(name, password);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return html`<div class="auth on-bg">
    <img class="auth-mark" src="/icons/icon-192.png" alt="" width="72" height="72" />
    <h1 class="h1">${copy.title}</h1>
    <p class="sub soft" style=${{ marginTop: '10px' }}>${copy.text}</p>

    <form onSubmit=${submit} novalidate>
      <${Field} label="Name">
        <input
          class="input"
          name="username"
          autocomplete="username"
          autocapitalize="words"
          spellcheck="false"
          placeholder="Your name"
          value=${name}
          onInput=${(event) => setName(event.target.value)}
        />
      <//>
      <${Field} label="Password">
        <${PasswordInput} value=${password} onInput=${setPassword} isNew=${mode !== 'login'} />
      <//>
      ${mode === 'signup' &&
      html`<${Field} label="Invite code">
        <input
          class="input"
          name="invite"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          placeholder="XXXX-XXXX"
          value=${code}
          onInput=${(event) => setCode(event.target.value)}
        />
      <//>`}
      ${error && html`<div class="form-error" role="alert">${error}</div>`}
      <button class="btn btn-primary btn-lg btn-block" type="submit" style=${{ marginTop: '6px' }}>
        ${busy ? html`<${Spinner} small />` : copy.button}
      </button>
    </form>

    ${!needsSetup &&
    html`<p class="auth-switch">
      ${wantsSignup ? 'Already have an account? ' : 'Have an invite code? '}
      <button
        class="link"
        onClick=${() => {
          setWantsSignup(!wantsSignup);
          setError('');
        }}
      >
        ${wantsSignup ? 'Sign in' : 'Create an account'}
      </button>
    </p>`}
  </div>`;
}
