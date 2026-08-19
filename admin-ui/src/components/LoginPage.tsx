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
    <div className="relative flex min-h-dvh items-center justify-center px-4 py-10 sm:py-16">
      {/* Atmospheric background: layered glows + subtle dot grid */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        {/* Primary glow — top center */}
        <div className="absolute -top-32 left-1/2 h-[500px] w-[500px] -translate-x-1/2 rounded-full bg-primary/[0.07] blur-[100px]" />
        {/* Info glow — bottom right */}
        <div className="absolute -bottom-24 -right-20 h-80 w-80 rounded-full bg-info/[0.06] blur-[80px]" />
        {/* Warm accent — bottom left */}
        <div className="absolute -bottom-16 -left-16 h-64 w-64 rounded-full bg-warning/[0.04] blur-[70px]" />
        {/* Subtle dot grid for texture */}
        <div
          className="absolute inset-0 opacity-[0.035]"
          style={{
            backgroundImage:
              "radial-gradient(circle, currentColor 1px, transparent 1px)",
            backgroundSize: "24px 24px",
          }}
        />
      </div>

      {/* m-auto centers both axes and scrolls cleanly when the card is
          taller than the viewport (short laptop windows / mobile landscape). */}
      <div className="fade-in relative m-auto w-full max-w-sm">
        <div className="overflow-hidden rounded-xl border border-border/80 bg-card/95 shadow-2xl shadow-black/25 backdrop-blur-sm">
          {/* Brand accent bar — gradient sweep */}
          <div
            className="h-[3px] bg-gradient-to-r from-primary/60 via-info/50 to-primary/60"
            aria-hidden="true"
          />

          <div className="p-8 sm:p-9">
            {/* Brand header */}
            <div className="mb-8 text-center">
              <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/20 to-primary/[0.05] text-primary ring-1 ring-primary/20 shadow-sm shadow-primary/10">
                <ShieldCheck className="h-7 w-7" aria-hidden="true" />
              </span>
              <h1 className="mt-4 text-xl font-bold tracking-tight">uNetWatch</h1>
              <p className="mt-1.5 text-sm text-muted-foreground">Sign in to the admin console</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-1.5">
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

              <div className="space-y-1.5">
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
                    className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
