import { useState } from "react"
import {
  AlertTriangle,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  ShieldCheck,
  User,
} from "lucide-react"
import { login, setToken } from "../api"
import { Button, Input, Label } from "./ui"

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError("")
    try {
      const res = await login(username, password)
      setToken(res.token)
      onLogin()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative flex min-h-dvh px-4 py-10 sm:py-16">
      {/* Decorative background glow */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -top-40 left-1/2 h-80 w-80 -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute -bottom-32 -right-24 h-72 w-72 rounded-full bg-info/10 blur-3xl" />
      </div>

      {/* m-auto centers both axes and scrolls cleanly when the card is
          taller than the viewport (short laptop windows / mobile landscape). */}
      <div className="fade-in relative m-auto w-full max-w-sm">
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xl shadow-black/20">
          {/* Brand accent bar */}
          <div
            className="h-1 bg-gradient-to-r from-primary/70 via-info/60 to-primary/70"
            aria-hidden="true"
          />

          <div className="p-8 sm:p-9">
            {/* Brand header */}
            <div className="mb-8 text-center">
              <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/25 to-primary/5 text-primary ring-1 ring-primary/30">
                <ShieldCheck className="h-7 w-7" aria-hidden="true" />
              </span>
              <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Admin Console
              </p>
              <h1 className="mt-1 text-xl font-bold tracking-tight">ELK Monitoring</h1>
              <p className="mt-1 text-sm text-muted-foreground">Sign in to continue</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="login-username">Username</Label>
                <div className="relative">
                  <User
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    id="login-username"
                    name="username"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => {
                      setUsername(e.target.value)
                      if (error) setError("")
                    }}
                    placeholder="admin"
                    className="pl-9"
                    autoFocus
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="login-password">Password</Label>
                <div className="relative">
                  <Lock
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    id="login-password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value)
                      if (error) setError("")
                    }}
                    placeholder="Enter your password"
                    className="pl-9 pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    aria-controls="login-password"
                    aria-pressed={showPassword}
                    className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Eye className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>

              {error && (
                <div
                  className="flex items-start gap-2.5 rounded-md border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger"
                  role="alert"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 break-words">{error}</span>
                </div>
              )}

              <Button
                type="submit"
                disabled={loading}
                className="h-11 w-full text-sm font-semibold"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Signing in…
                  </>
                ) : (
                  "Sign In"
                )}
              </Button>
            </form>
          </div>
        </div>

        <p className="mt-5 text-center text-xs text-muted-foreground">
          Restricted area · only administrators can sign in
        </p>
      </div>
    </div>
  )
}
