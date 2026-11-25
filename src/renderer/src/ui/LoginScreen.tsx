import { useState, type FormEvent } from 'react'
import type { InfoflexBridge } from '@shared/bridge'
import type { PublicUser } from '@shared/auth/types'
import type { ShopSettings } from '@shared/shop/types'

interface Props {
  bridge: InfoflexBridge
  settings: ShopSettings
  productName: string
  appVersion: string
  /**
   * Which application this is. The Server accepts only the Admin; a client accepts the staff roles. The screen says
   * which rule applies *before* anybody types, so the right person is not left guessing, while the refusal itself
   * stays generic (the server never says whether a username exists).
   */
  appRole: 'server' | 'client'
  onLogin: (user: PublicUser) => void
}

/** The line under the heading, and the note at the foot, for each application. */
const APP_COPY = {
  server: {
    eyebrow: 'SERVER SIGN-IN',
    heading: 'Admin sign-in',
    lead: 'This is the shop server. Sign in with the Admin account.',
    rule: 'Only the Admin signs in here. Accounts, Users and Supervisors use the client app on their own PC.',
  },
  client: {
    eyebrow: 'TILL SIGN-IN',
    heading: 'Welcome back',
    lead: 'Sign in to take orders, payments and returns.',
    rule: 'Accounts, Users and Supervisors sign in here. The Admin signs in on the shop server.',
  },
} as const

export function LoginScreen({ bridge, settings, productName, appVersion, appRole, onLogin }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const copy = APP_COPY[appRole]

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const user = await bridge.login({ username, password })
      setPassword('')
      onLogin(user)
    } catch (caught) {
      // The server's refusals are deliberately identical whether or not a username exists, and whether the password was
      // wrong or the person is on the wrong application. The screen must not improve on that by guessing — so it shows
      // the message it was given and adds nothing.
      setError(caught instanceof Error ? caught.message : 'Unable to sign in. Try again or contact the Admin.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="login-screen">
      <div className="login-overlay" aria-hidden="true" />
      <section className="login-content">
        <img className="login-logo" src="/branding/logo-transparent.png" alt="Infoflex — Strategy | Consulting | Innovation" />
        <p className="login-product-name">{productName}</p>
        <p className="login-tagline">Strategy | Consulting | Innovation</p>
        <form className="login-card" onSubmit={submit}>
          <div className="login-card__heading">
            <span className="eyebrow eyebrow--gold">{copy.eyebrow}</span>
            <h1>{copy.heading}</h1>
            <p>{copy.lead}</p>
          </div>
          <label className="field" htmlFor="login-username"><span>Username</span><input id="login-username" name="username" autoComplete="username" autoCapitalize="none" required maxLength={32} value={username} onChange={(event) => setUsername(event.target.value)} autoFocus /></label>
          <label className="field" htmlFor="login-password"><span>Password</span><div className="password-input-wrap"><input id="login-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /><button className="password-visibility" type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((visible) => !visible)}>{showPassword ? 'Hide' : 'Show'}</button></div></label>
          {error && <div className="form-error" role="alert"><span>!</span>{error}</div>}
          <button className="primary-button login-submit" type="submit" disabled={submitting}>{submitting ? 'Signing in…' : 'Sign in'}<span aria-hidden="true">→</span></button>
          <p className="login-security-note">{copy.rule}</p>
          <p className="login-security-note">For your security, there is no self sign-up or password recovery link. Contact the Admin to reset access.</p>
        </form>
        <p className="login-store-name">{settings.profile.name}</p>
        <p className="login-version">Version {appVersion}</p>
      </section>
    </main>
  )
}
