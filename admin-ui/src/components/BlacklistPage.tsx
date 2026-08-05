import { useCallback, useEffect, useState } from "react"
import { Ban, Copy, Link2, RefreshCcw } from "lucide-react"
import { getBlacklistUrls, getBlacklistIps } from "../api"
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Skeleton, useToast } from "./ui"

interface FeedCardProps {
  title: string
  path: string
  body: string
  loading: boolean
  onRefresh: () => void
  onCopy: () => void
}

function FeedCard({ title, path, body, loading, onRefresh, onCopy }: FeedCardProps) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <CardTitle>{title}</CardTitle>
          <code className="mt-1.5 inline-block rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground">
            {path}
          </code>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
            <RefreshCcw className="h-3.5 w-3.5" />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={onCopy} disabled={loading || !body}>
            <Copy className="h-3.5 w-3.5" />
            Copy
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-40 w-full" />
        ) : body ? (
          <pre className="rounded-md border border-border bg-muted/30 p-3 text-xs font-mono overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap break-all">
            {body}
          </pre>
        ) : (
          <EmptyState icon={Link2} title="Empty feed" description="No entries yet." />
        )}
      </CardContent>
    </Card>
  )
}

export function BlacklistPage() {
  const [urls, setUrls] = useState<string>("")
  const [ips, setIps] = useState<string>("")
  const [loading, setLoading] = useState(true)
  const [, setError] = useState<string | null>(null)
  const { toast } = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [u, i] = await Promise.all([getBlacklistUrls(), getBlacklistIps()])
      setUrls(u)
      setIps(i)
    } catch (e) {
      const msg = (e as Error).message
      setError(msg)
      toast({ title: "Failed to load blacklist", description: msg, variant: "error" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    load()
  }, [load])

  const copy = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text)
        toast({ title: `${label} copied`, variant: "success" })
      } catch {
        toast({ title: "Copy failed", variant: "error" })
      }
    },
    [toast],
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2.5">
        <Ban className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Blacklist</h1>
          <p className="text-sm text-muted-foreground">
            URL and IP blacklists exposed as plain text for external integrations.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <FeedCard
          title="URL blacklist"
          path="/api/blacklist/urls"
          body={urls}
          loading={loading}
          onRefresh={load}
          onCopy={() => copy(urls, "URLs")}
        />
        <FeedCard
          title="IP blacklist"
          path="/api/blacklist/ips"
          body={ips}
          loading={loading}
          onRefresh={load}
          onCopy={() => copy(ips, "IPs")}
        />
      </div>
    </div>
  )
}
