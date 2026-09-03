import { useCallback, useEffect, useState } from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"
import {
  Activity,
  Bell,
  KeyRound,
  ListTree,
  Plug,
  Save,
  ShieldCheck,
} from "lucide-react"
import {
  type AlertSettings,
  type FieldMap,
  type KibanaSettings,
  getAlerts,
  getFieldMap,
  getKibanaSettings,
  putAlerts,
  putFieldMap,
  putKibanaSettings,
  testKibanaConnection,
} from "../api"
import { cn } from "../lib/utils"
import { FieldMapper } from "./FieldMapper"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  PageHeader,
  Panel,
  Select,
  Skeleton,
  useToast,
  type SelectOption,
} from "./ui"

/* ── Tabs (Radix) — NOC soft underline style ─────────────────────── */

function Tabs({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <TabsPrimitive.Root value={value} onValueChange={onValueChange}>
      {children}
    </TabsPrimitive.Root>
  )
}

function TabsList({ children }: { children: React.ReactNode }) {
  return (
    <TabsPrimitive.List className="flex flex-wrap items-center gap-1 border-b border-border">
      {children}
    </TabsPrimitive.List>
  )
}

function TabsTrigger({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className={cn(
        "inline-flex items-center gap-2 rounded-t-md border border-b-0 border-transparent px-4 py-2.5 font-sans text-xs font-semibold uppercase tracking-wide text-muted-foreground",
        "transition-colors hover:text-foreground",
        "data-[state=active]:border-border data-[state=active]:bg-card data-[state=active]:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "cursor-pointer",
      )}
    >
      {children}
    </TabsPrimitive.Trigger>
  )
}

function TabsContent({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TabsPrimitive.Content value={value} className="mt-4 outline-none">
      {children}
    </TabsPrimitive.Content>
  )
}

/* ── Auth + webhook option constants ─────────────────────────────── */

const AUTH_OPTIONS: SelectOption[] = [
  { value: "apiKey", label: "API Key" },
  { value: "basic", label: "Basic Auth" },
  { value: "oauth2", label: "OAuth2" },
]

const WEBHOOK_OPTIONS: SelectOption[] = [
  { value: "none", label: "No Webhook" },
  { value: "slack", label: "Slack" },
  { value: "msteams", label: "MS Teams" },
]

const WINDOW_OPTIONS: SelectOption[] = [
  { value: "5", label: "5 min" },
  { value: "15", label: "15 min" },
  { value: "30", label: "30 min" },
  { value: "60", label: "60 min" },
  { value: "1440", label: "24 h" },
]

/* ── Page ────────────────────────────────────────────────────────── */

export function SystemSettingsPage() {
  const { toast } = useToast()
  const [tab, setTab] = useState("kibana")

  const [kibana, setKibana] = useState<KibanaSettings | null>(null)
  const [fieldMap, setFieldMap] = useState<FieldMap | null>(null)
  const [alerts, setAlerts] = useState<AlertSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  // Load all three settings sections in parallel on mount.
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [k, f, a] = await Promise.all([getKibanaSettings(), getFieldMap(), getAlerts()])
      setKibana(k)
      setFieldMap(f)
      setAlerts(a)
    } catch (e) {
      toast({ title: "Failed to load settings", description: (e as Error).message, variant: "error" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    load()
  }, [load])

  const handleTestConnection = async () => {
    if (!kibana) return
    setTesting(true)
    try {
      const res = await testKibanaConnection(kibana)
      if (res.ok) {
        toast({
          title: "Connection OK",
          description: `${res.latencyMs}ms${res.status ? ` · HTTP ${res.status}` : ""}`,
          variant: "success",
        })
      } else {
        toast({
          title: "Connection failed",
          description: res.error ?? `HTTP ${res.status}`,
          variant: "error",
        })
      }
    } catch (e) {
      toast({ title: "Connection test error", description: (e as Error).message, variant: "error" })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    if (!kibana || !fieldMap || !alerts) return
    setSaving(true)
    try {
      await Promise.all([putKibanaSettings(kibana), putFieldMap(fieldMap), putAlerts(alerts)])
      toast({ title: "Settings saved", description: "Kibana connection, field map and alert rules persisted", variant: "success" })
    } catch (e) {
      toast({ title: "Save failed", description: (e as Error).message, variant: "error" })
    } finally {
      setSaving(false)
    }
  }

  if (loading || !kibana || !fieldMap || !alerts) {
    return (
      <div className="space-y-5">
        <PageHeader title="System Settings" description="Kibana connection, field mapping, thresholds and access control">
          <Button variant="outline" disabled><Activity className="h-4 w-4" /> Test Connection</Button>
          <Button disabled><Save className="h-4 w-4" /> Save</Button>
        </PageHeader>
        <div className="space-y-3">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader title="System Settings" description="Kibana connection, field mapping, thresholds and access control">
        <Button variant="outline" onClick={handleTestConnection} disabled={testing}>
          <Activity className="h-4 w-4" />
          {testing ? "Testing…" : "Test Connection"}
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          <Save className="h-4 w-4" />
          {saving ? "Saving…" : "Save"}
        </Button>
      </PageHeader>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="kibana"><Plug className="h-3.5 w-3.5" /> Kibana Connection</TabsTrigger>
          <TabsTrigger value="fieldMap"><ListTree className="h-3.5 w-3.5" /> Field Mapping</TabsTrigger>
          <TabsTrigger value="alerts"><Bell className="h-3.5 w-3.5" /> Alert Rules</TabsTrigger>
          <TabsTrigger value="access"><ShieldCheck className="h-3.5 w-3.5" /> User Access Control</TabsTrigger>
        </TabsList>

        <TabsContent value="kibana">
          <Panel title="Kibana Connection" description="How the monitor reaches Elasticsearch / Kibana" icon={Plug}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="kibana-host">Kibana Host URL</Label>
                <Input
                  id="kibana-host"
                  className="font-mono text-xs"
                  value={kibana.host_url}
                  onChange={(e) => setKibana({ ...kibana, host_url: e.target.value })}
                  placeholder="https://kibana-internal.corp.net:5601"
                />
              </div>
              <div>
                <Label htmlFor="kibana-index">Index Pattern</Label>
                <Input
                  id="kibana-index"
                  className="font-mono text-xs"
                  value={kibana.index_pattern}
                  onChange={(e) => setKibana({ ...kibana, index_pattern: e.target.value })}
                  placeholder="logstash-network-traffic-*"
                />
              </div>
              <div>
                <Label htmlFor="kibana-auth">Auth Type</Label>
                <Select
                  id="kibana-auth"
                  value={kibana.auth_type}
                  onChange={(v) => setKibana({ ...kibana, auth_type: v as KibanaSettings["auth_type"] })}
                  options={AUTH_OPTIONS}
                  aria-label="Kibana auth type"
                />
              </div>
              <div>
                <Label htmlFor="kibana-api-key">API Key</Label>
                <Input
                  id="kibana-api-key"
                  type="password"
                  className="font-mono text-xs"
                  value={kibana.api_key ?? ""}
                  onChange={(e) => setKibana({ ...kibana, api_key: e.target.value || null })}
                  placeholder="Base64 API key for ApiKey / OAuth2"
                  autoComplete="off"
                />
              </div>
            </div>
            <p className="mt-4 max-w-[60ch] text-sm leading-relaxed text-muted-foreground">
              Test Connection pings the host with the credentials above and reports latency. Save persists the
              connection form — the monitor re-reads it on the next poll.
            </p>
          </Panel>
        </TabsContent>

        <TabsContent value="fieldMap">
          <Panel title="Field Mapping" description="Map NOC app attributes to Kibana log field names (spec §3.5)" icon={ListTree}>
            <FieldMapper value={fieldMap} onChange={setFieldMap} />
            <p className="mt-4 max-w-[60ch] text-sm leading-relaxed text-muted-foreground">
              These mappings drive the query pipeline (Task 12): the app reads the persisted map so custom index
              schemas work without code changes. Sample values show the typical content of each field.
            </p>
          </Panel>
        </TabsContent>

        <TabsContent value="alerts">
          <Panel title="Alert Rules" description="DENY-ratio threshold and webhook delivery (spec §3.5)" icon={Bell}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>DENY Ratio Threshold</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-end justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <Label htmlFor="deny-ratio">Alert when denied traffic exceeds</Label>
                      <input
                        id="deny-ratio"
                        type="range"
                        min={0}
                        max={100}
                        step={0.1}
                        value={alerts.deny_ratio_pct}
                        onChange={(e) => setAlerts({ ...alerts, deny_ratio_pct: Number(e.target.value) })}
                        className="w-full accent-[#6366F1]"
                        aria-label="DENY ratio threshold percent"
                      />
                    </div>
                    <div className="text-right">
                      <span className="font-mono text-2xl font-extrabold tabular-nums">
                        {alerts.deny_ratio_pct.toFixed(1)}%
                      </span>
                      <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                        of window traffic
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Evaluation Window</CardTitle>
                </CardHeader>
                <CardContent>
                  <Label htmlFor="window-minutes">Rolling window</Label>
                  <Select
                    id="window-minutes"
                    value={String(alerts.window_minutes)}
                    onChange={(v) => setAlerts({ ...alerts, window_minutes: Number(v) })}
                    options={WINDOW_OPTIONS}
                    aria-label="Alert evaluation window"
                  />
                  <p className="mt-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                    Default: 15 min
                  </p>
                </CardContent>
              </Card>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="webhook-type">Webhook Provider</Label>
                <Select
                  id="webhook-type"
                  value={alerts.webhook_type}
                  onChange={(v) => setAlerts({ ...alerts, webhook_type: v as AlertSettings["webhook_type"] })}
                  options={WEBHOOK_OPTIONS}
                  aria-label="Webhook provider"
                />
              </div>
              <div>
                <Label htmlFor="webhook-url">Webhook URL</Label>
                <Input
                  id="webhook-url"
                  className="font-mono text-xs"
                  value={alerts.webhook_url}
                  onChange={(e) => setAlerts({ ...alerts, webhook_url: e.target.value })}
                  placeholder="https://hooks.slack.com/services/…"
                />
              </div>
            </div>
            <p className="mt-4 max-w-[60ch] text-sm leading-relaxed text-muted-foreground">
              When the DENY ratio over the rolling window exceeds the threshold, an alert fires to the configured
              webhook (Slack or MS Teams). Leave the provider at None to disable notifications.
            </p>
          </Panel>
        </TabsContent>

        <TabsContent value="access">
          <Panel title="User Access Control" description="How the admin UI authenticates requests (read-only summary)" icon={ShieldCheck}>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3">
                <div className="flex items-center gap-3">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="font-sans text-sm font-semibold">Basic Auth</p>
                    <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                      ADMIN_USER / ADMIN_PASS (env)
                    </p>
                  </div>
                </div>
                <Badge variant="success">Active</Badge>
              </div>
              <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3">
                <div className="flex items-center gap-3">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="font-sans text-sm font-semibold">API Key</p>
                    <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                      X-API-Key header or session token
                    </p>
                  </div>
                </div>
                <Badge variant="success">Active</Badge>
              </div>
              <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3">
                <div className="flex items-center gap-3">
                  <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="font-sans text-sm font-semibold">Role-based accounts</p>
                    <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                      Admin / Analyst / Viewer
                    </p>
                  </div>
                </div>
                <Badge variant="warning">Planned</Badge>
              </div>
            </div>
            <p className="mt-4 max-w-[60ch] text-sm leading-relaxed text-muted-foreground">
              All /api/settings/* routes require admin credentials (Basic Auth or X-API-Key). Fine-grained
              role-based access control is on the roadmap — this panel summarizes the current enforcement.
            </p>
          </Panel>
        </TabsContent>
      </Tabs>
    </div>
  )
}
