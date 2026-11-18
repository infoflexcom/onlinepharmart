import { useState, type FormEvent } from 'react'
import type { InfoflexBridge } from '@shared/bridge'
import type { PublicUser } from '@shared/auth/types'
import type { ShopSettings } from '@shared/shop/types'

interface Props {
  bridge: InfoflexBridge
  settings: ShopSettings
  productName: string
  appVersion: string
  onLogin: (user: PublicUser) => void
}

export function LoginScreen({ bridge, settings, productName, appVersion, onLogin }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const user = await bridge.login({ username, password })
      setPassword('')
      onLogin(user)
    } catch (caught) {
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
          <div className="login-card__heading"><span className="eyebrow eyebrow--gold">SECURE SHOP ACCESS</span><h1>Welcome back</h1><p>Sign in with your shop account.</p></div>
          <label className="field" htmlFor="login-username"><span>Username</span><input id="login-username" name="username" autoComplete="username" autoCapitalize="none" required maxLength={32} value={username} onChange={(event) => setUsername(event.target.value)} autoFocus /></label>
          <label className="field" htmlFor="login-password"><span>Password</span><div className="password-input-wrap"><input id="login-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /><button className="password-visibility" type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((visible) => !visible)}>{showPassword ? 'Hide' : 'Show'}</button></div></label>
          {error && <div className="form-error" role="alert"><span>!</span>{error}</div>}
          <button className="primary-button login-submit" type="submit" disabled={submitting}>{submitting ? 'Signing in…' : 'Sign in'}<span aria-hidden="true">→</span></button>
          <p className="login-security-note">For your security, there is no self sign-up or password recovery link. Contact the Admin to reset access.</p>
        </form>
        <p className="login-store-name">{settings.profile.name}</p>
        <p className="login-version">Version {appVersion}</p>
      </section>
    </main>
  )
}
