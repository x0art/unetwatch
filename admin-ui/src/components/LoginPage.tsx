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
      {/* grid paper */}
      <div className="grid-paper pointer-events-none absolute inset-0 opacity-30" aria-hidden="true" />
      <div className="halftone pointer-events-none absolute inset-0" aria-hidden="true" />

      <div className="fade-in relative m-auto w-full max-w-sm">
        {/* Brutal slab */}
        <div className="overflow-hidden border-[3px] border-[#0A0A0A] bg-card brutal-shadow-lg dark:border-[#F6F2E8]">
          <div className="hazard-bar" aria-hidden="true" />

          <div className="p-8 sm:p-8">
            {/* Brand — stamp + display */}
            <div className="mb-6 text-center">
              <span className="inline-flex h-14 w-14 items-center justify-center border-[2.5px] border-[#0A0A0A] bg-[#FFD60A] text-[#0A0A0A] brutal-shadow-sm">
                <ShieldCheck className="h-7 w-7" aria-hidden="true" />
              </span>
              <h1 className="font-display mt-4 text-[22px]">UNETWATCH</h1>
              <p className="mono-label mt-1">[ ADMIN CONSOLE // SIGN IN ]</p>
              <div className="mx-auto mt-3 h-1 w-12 bg-[#0A0A0A] dark:bg-[#F6F2E8]" aria-hidden="true" />
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="login-username">USERNAME</Label>
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
                    className="pl-9 font-mono text-sm"
                    autoFocus
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="login-password">PASSWORD</Label>
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
                    className="pl-9 pr-10 font-mono text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    aria-controls="login-password"
                    aria-pressed={showPassword}
                    className="absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center border-[2px] border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                  </button>
                </div>
              </div>

              {error && (
                <div className="flex items-start gap-2 border-[2.5px] border-[#0A0A0A] bg-danger px-3 py-2.5 font-mono text-xs font-bold uppercase tracking-widest text-white" role="alert">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 break-words">{error}</span>
                </div>
              )}

              <Button type="submit" disabled={loading} className="h-11 w-full text-xs">
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    SIGNING IN...
                  </>
                ) : (
                  "SIGN IN — ENTER"
                )}
              </Button>
            </form>
          </div>

          <div className="border-t-[3px] border-[#0A0A0A] bg-secondary px-4 py-2 text-center font-mono text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#0A0A0A] dark:border-[#F6F2E8]">
            RESTRICTED AREA — ADMINISTRATORS ONLY
          </div>
        </div>

        <p className="mt-4 text-center font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          [ SECURE // ENCRYPTED // AUDITED ]
        </p>
      </div>
    </div>
  )
}
