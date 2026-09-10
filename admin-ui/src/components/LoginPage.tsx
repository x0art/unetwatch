import { useState } from "react"
import { AlertTriangle, Eye, EyeOff, Loader2, Lock, ShieldCheck, User } from "lucide-react"
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
    <div className="relative flex min-h-dvh items-center justify-center bg-background px-4 py-10 sm:py-16">
      <div className="fade-in relative m-auto w-full max-w-sm">
        <div className="rounded-md border border-border bg-card shadow-sm overflow-hidden">

          <div className="p-8 sm:p-8">
            {/* Brand */}
            <div className="mb-6 text-center">
              <span className="inline-flex h-14 w-14 items-center justify-center rounded-md border border-transparent bg-primary text-white shadow-sm">
                <ShieldCheck className="h-7 w-7" aria-hidden="true" />
              </span>
              <h1 className="mt-4 text-[22px] font-semibold tracking-tight">uNetWatch</h1>
              <p className="mono-label mt-1">Admin console — sign in</p>
              <div className="mx-auto mt-3 h-1 w-12 bg-border" aria-hidden="true" />
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="login-username">Username</Label>
                <div className="relative">
                  <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
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
                    className="pl-9 text-sm"
                    autoFocus
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="login-password">Password</Label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
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
                    placeholder="••••••••"
                    className="pl-9 pr-10 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    aria-controls="login-password"
                    aria-pressed={showPassword}
                    className="absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md border border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                  </button>
                </div>
              </div>

              {error && (
                <div className="flex items-start gap-2 rounded-md border border-danger/20 bg-danger/10 px-3 py-2.5 text-xs font-medium text-danger" role="alert">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 break-words">{error}</span>
                </div>
              )}

              <Button type="submit" disabled={loading} className="h-11 w-full text-xs">
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Signing in…
                  </>
                ) : (
                  "Sign in"
                )}
              </Button>
            </form>
          </div>

          <div className="border-t border-border bg-secondary px-4 py-2 text-center text-xs font-medium text-secondary-foreground">
            Restricted area — administrators only
          </div>
        </div>
      </div>
    </div>
  )
}
