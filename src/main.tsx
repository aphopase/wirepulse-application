import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { EnterpriseConsole } from "./EnterpriseConsole";
import { acceptInvitation, createResource, createTestJob, createTestReport, createWorkspace, EnterpriseApiError, listMyInvitations, listWorkspaces, type EnterpriseWorkspace, type PendingInvitation } from "./enterprise";
import "./styles.css";

type SerialParity = "none" | "even" | "odd";
type SerialFlowControl = "none" | "hardware";
type SerialPortLike = {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number; dataBits: 7 | 8; stopBits: 1 | 2; parity: SerialParity; flowControl: SerialFlowControl }): Promise<void>;
  close(): Promise<void>;
};
type SerialManager = {
  requestPort(): Promise<SerialPortLike>;
  getPorts?(): Promise<SerialPortLike[]>;
  addEventListener?(type: "connect" | "disconnect", callback: (event: { port: SerialPortLike }) => void): void;
  removeEventListener?(type: "connect" | "disconnect", callback: (event: { port: SerialPortLike }) => void): void;
};
declare global { interface Navigator { serial?: SerialManager } }

type Direction = "rx" | "tx" | "system";
type LogLine = { time: string; at: number; text: string; direction: Direction };
type Point = { t: number; value: number };
type Macro = { label: string; command: string };
type Settings = {
  baud: string; dataBits: 7 | 8; stopBits: 1 | 2; parity: SerialParity; flow: SerialFlowControl;
  format: "ascii" | "hex" | "binary"; ending: "\n" | "\r" | "\r\n" | ""; autoscroll: boolean;
  theme: string; maxLines: number; nmeaEnabled: boolean; autoReconnect: boolean; binaryFrameEnabled: boolean; frameStart: string; frameEnd: string; checksum: "none" | "xor";
  autoDetectProbe: string; autoDetectDwellMs: number;
};
type RawChunk = { at: number; bytes: number[] };
type SessionFile = { app: "WirePulse"; version: 2; recordedAt: string; lines: LogLine[]; rawChunks?: RawChunk[] };
type TelemetryChannel = { token: string; label: string; unit: string; warning: string; critical: string; enabled: boolean };
type AlertLevel = "warning" | "critical";
type DeviceProfile = { id: string; name: string; createdAt: string; updatedAt: string; settings: Settings; macros: Macro[]; channels: TelemetryChannel[] };
type TestDefinition = { id: string; name: string; commands: string; expectedText: string; telemetryToken: string; telemetryOperator: ">=" | "<=" | "="; telemetryValue: string; timeoutMs: number; retries: number };
type TestResult = { testId: string; name: string; status: "passed" | "failed" | "not-run"; startedAt?: number; finishedAt?: number; detail: string; attempts: number };
type EvidenceEventType = "run.started" | "attempt.started" | "command.transmitted" | "response.window.opened" | "assertion.completed" | "attempt.timed_out" | "run.finished" | "run.stopped";
type EvidenceEvent = { sequence: number; at: number; type: EvidenceEventType; payload: Record<string, unknown>; previousHash: string; hash: string };
type EvidenceBundle = { schema: "wirepulse.test-evidence.v1"; evidenceId: string; createdAt: string; fingerprints: { suite: string; profile: string; engine: string }; rootHash: string; events: EvidenceEvent[]; finalHash: string };
type EvidenceLedger = { bundle: EvidenceBundle; latestHash: string };
type ResponseObservation = { firstChunkSequence: number; lastChunkSequence: number; byteLength: number; observedAt: number };
type SendReceipt = { sequence: number; at: number; byteLength: number };
type ActiveTest = { test: TestDefinition; attempt: number; deadline: number; resultIndex: number; responseWindowOpen: boolean; responseStartAt: number; responseStartRxSequence: number; staleLines: number };

const BAUDS = ["auto", "300", "1200", "2400", "4800", "9600", "19200", "38400", "57600", "74880", "115200", "230400", "250000", "460800", "500000", "921600", "1000000", "1500000"];
const THEMES = ["Obsidian", "Nord", "Amber", "Phosphor"];
const DEFAULT_SETTINGS: Settings = { baud: "115200", dataBits: 8, stopBits: 1, parity: "none", flow: "none", format: "ascii", ending: "\n", autoscroll: true, theme: "Obsidian", maxLines: 2000, nmeaEnabled: false, autoReconnect: true, binaryFrameEnabled: false, frameStart: "AA", frameEnd: "55", checksum: "none", autoDetectProbe: "", autoDetectDwellMs: 650 };
const DEFAULT_MACROS: Macro[] = [
  { label: "Status", command: "status" }, { label: "Help", command: "help" },
  { label: "Version", command: "version" }, { label: "Reset", command: "reset" }
];
const SETTINGS_KEY = "wirepulse.settings.v1";
const MACROS_KEY = "wirepulse.macros.v1";
const TELEMETRY_KEY = "wirepulse.telemetry.v1";
const PROFILES_KEY = "wirepulse.profiles.v1";
const TESTS_KEY = "wirepulse.tests.v1";
const DEFAULT_TESTS: TestDefinition[] = [{ id: "firmware-ready", name: "Firmware ready", commands: "status", expectedText: "READY", telemetryToken: "", telemetryOperator: ">=", telemetryValue: "", timeoutMs: 2000, retries: 0 }];
const DEFAULT_CHANNELS: TelemetryChannel[] = Array.from({ length: 10 }, (_, index) => ({ token: `TEMP${index}`, label: `Channel ${index}`, unit: "", warning: "", critical: "", enabled: true }));
const CHANNEL_COLORS = ["#58d6bd", "#5ca5ff", "#c8a7ff", "#ffb45d", "#f3769b", "#77d6ff", "#b9e769", "#ffdc75", "#7ee0cf", "#e8a6d9"];

function loadStored<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    if (!value) return fallback;
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(fallback)) return (Array.isArray(parsed) ? parsed : fallback) as T;
    return (parsed && typeof parsed === "object" ? { ...fallback, ...parsed as object } : fallback) as T;
  } catch { return fallback; }
}
function newId(): string { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function saveStored<T>(key: string, value: T): void { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private browsing may reject storage */ } }
function now(): string { return new Date().toLocaleTimeString([], { hour12: false }); }
function hexBytes(bytes: Uint8Array | number[]): string { return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ").toUpperCase(); }
function decode(bytes: Uint8Array, format: Settings["format"]): string {
  if (format === "hex") return hexBytes(bytes);
  if (format === "binary") return [...bytes].map((byte) => byte.toString(2).padStart(8, "0")).join(" ");
  return new TextDecoder().decode(bytes);
}
function parseHex(value: string): number | null { const normalized = value.replace(/\s+/g, "").replace(/^0x/i, ""); return /^[0-9a-f]{2}$/i.test(normalized) ? Number.parseInt(normalized, 16) : null; }
function decodeFrames(bytes: Uint8Array, settings: Settings): string[] {
  if (!settings.binaryFrameEnabled) return [];
  const start = parseHex(settings.frameStart); const end = parseHex(settings.frameEnd);
  if (start === null || end === null) return ["Frame decoder needs two valid hex bytes, for example AA and 55."];
  const messages: string[] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const open = bytes.indexOf(start, cursor); if (open === -1) break;
    const close = bytes.indexOf(end, open + 1); if (close === -1) break;
    const frame = bytes.slice(open, close + 1);
    const payload = frame.slice(1, -1);
    const checksumOk = settings.checksum === "none" || payload.length < 2 ? null : payload.slice(0, -1).reduce((value, byte) => value ^ byte, 0) === payload[payload.length - 1];
    messages.push(`FRAME ${hexBytes(frame)}${checksumOk === null ? "" : checksumOk ? " · XOR OK" : " · XOR FAIL"}`);
    cursor = close + 1;
  }
  return messages;
}
function nmeaCoord(value: string, hemisphere: string): number {
  const degrees = Number(value.slice(0, -7));
  const minutes = Number(value.slice(-7));
  return (degrees + minutes / 60) * (hemisphere === "S" || hemisphere === "W" ? -1 : 1);
}
function safeFileName(): string { return new Date().toISOString().replace(/[:.]/g, "-"); }
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function evidenceFingerprint(value: unknown): Promise<string> { return sha256(canonicalize(value)); }
function responseEvidence(observation: ResponseObservation | null | undefined): Record<string, number> | null {
  return observation ? { firstChunkSequence: observation.firstChunkSequence, lastChunkSequence: observation.lastChunkSequence, byteLength: observation.byteLength, observedAt: observation.observedAt } : null;
}
function download(content: string, name: string, type: string): void {
  const blob = new Blob([content], { type });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}
function serialDiagnostic(): string | null {
  if (!window.isSecureContext) return "Serial access is blocked because this page is not secure. Open WirePulse through localhost or an HTTPS URL, not a raw HTTP/IP address.";
  if (!navigator.serial) return "Web Serial is not exposed in this browser context. Use current Chrome or Edge in a normal browser tab, not an embedded preview or webview.";
  return null;
}
function lineLevel(line: LogLine): "error" | "warning" | "" {
  if (/\b(error|fatal|fail|panic|exception)\b/i.test(line.text)) return "error";
  if (/\b(warn|warning)\b/i.test(line.text)) return "warning";
  return "";
}
function normalizeChannels(value: unknown): TelemetryChannel[] {
  if (!Array.isArray(value)) return DEFAULT_CHANNELS;
  return DEFAULT_CHANNELS.map((fallback, index) => {
    const saved = value[index];
    return saved && typeof saved === "object" ? { ...fallback, ...saved } : fallback;
  });
}
function channelValueLevel(channel: TelemetryChannel, value: number): AlertLevel | null {
  const critical = Number(channel.critical);
  const warning = Number(channel.warning);
  if (channel.critical.trim() && Number.isFinite(critical) && value >= critical) return "critical";
  if (channel.warning.trim() && Number.isFinite(warning) && value >= warning) return "warning";
  return null;
}
function highlightedText(text: string, search: string): React.ReactNode {
  if (!search) return text;
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "ig"));
  return parts.map((part, index) => part.toLowerCase() === search.toLowerCase() ? <mark key={index}>{part}</mark> : part);
}

function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings>(() => loadStored(SETTINGS_KEY, DEFAULT_SETTINGS));
  const [macros, setMacros] = useState<Macro[]>(() => {
    const stored = loadStored<Macro[]>(MACROS_KEY, DEFAULT_MACROS);
    return Array.isArray(stored) && stored.length === 4 ? stored : DEFAULT_MACROS;
  });
  const [channels, setChannels] = useState<TelemetryChannel[]>(() => normalizeChannels(loadStored<unknown>(TELEMETRY_KEY, DEFAULT_CHANNELS)));
  const [profiles, setProfiles] = useState<DeviceProfile[]>(() => { const stored = loadStored<unknown>(PROFILES_KEY, []); return Array.isArray(stored) ? stored as DeviceProfile[] : []; });
  const [profileName, setProfileName] = useState("");
  const [enterpriseUrl, setEnterpriseUrl] = useState(() => localStorage.getItem("wirepulse.enterprise-url") ?? "");
  const [enterpriseToken, setEnterpriseToken] = useState("");
  const [enterpriseWorkspaces, setEnterpriseWorkspaces] = useState<EnterpriseWorkspace[]>([]);
  const [enterpriseWorkspaceId, setEnterpriseWorkspaceId] = useState("");
  const [enterpriseWorkspaceName, setEnterpriseWorkspaceName] = useState("");
  const [enterpriseStatus, setEnterpriseStatus] = useState("Connect an enterprise workspace only when your organization has deployed the control plane.");
  const [enterpriseBusy, setEnterpriseBusy] = useState(false);
  // The console follows the credentials used at connect time, not the input boxes, so typing a new token does not reopen its live stream.
  const [enterpriseSession, setEnterpriseSession] = useState<{ id: string; apiUrl: string; token: string } | null>(null);
  const [enterpriseInvitations, setEnterpriseInvitations] = useState<PendingInvitation[]>([]);
  const [tests, setTests] = useState<TestDefinition[]>(() => { const stored = loadStored<unknown>(TESTS_KEY, DEFAULT_TESTS); return Array.isArray(stored) ? stored as TestDefinition[] : DEFAULT_TESTS; });
  const [testResults, setTestResults] = useState<TestResult[]>([]);
  const [activeTest, setActiveTest] = useState<ActiveTest | null>(null);
  const [testRunning, setTestRunning] = useState(false);
  const [showTelemetryEditor, setShowTelemetryEditor] = useState(false);
  const [alerts, setAlerts] = useState<Array<{ at: number; id: number; level: AlertLevel; value: number }>>([]);
  const [port, setPort] = useState<SerialPortLike | null>(null);
  const [knownPort, setKnownPort] = useState<SerialPortLike | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionNote, setConnectionNote] = useState<string | null>(serialDiagnostic());
  const [lines, setLines] = useState<LogLine[]>([]);
  const [input, setInput] = useState("");
  const [paused, setPaused] = useState(false);
  const [search, setSearch] = useState("");
  const [directionFilter, setDirectionFilter] = useState<"all" | Direction>("all");
  const [showMacroEditor, setShowMacroEditor] = useState(false);
  const [rx, setRx] = useState(0);
  const [tx, setTx] = useState(0);
  const [warnings, setWarnings] = useState(0);
  const [errors, setErrors] = useState(0);
  const [points, setPoints] = useState<Record<number, Point[]>>({});
  const [gps, setGps] = useState<{ lat?: number; lon?: number; sats?: string }>({});
  const [recording, setRecording] = useState(false);
  const [recordedLines, setRecordedLines] = useState<LogLine[]>([]);
  const [rawChunks, setRawChunks] = useState<RawChunk[]>([]);
  const [loadedRecording, setLoadedRecording] = useState<LogLine[]>([]);
  const [replaying, setReplaying] = useState(false);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const decoderRef = useRef("");
  const textDecoderRef = useRef(new TextDecoder());
  const settingsRef = useRef(settings);
  const knownPortRef = useRef<SerialPortLike | null>(null);
  const recordingRef = useRef(false);
  const intentionalDisconnectRef = useRef(false);
  const replayTimerRef = useRef<number | null>(null);
  const testTimerRef = useRef<number | null>(null);
  const activeTestRef = useRef<ActiveTest | null>(null);
  const evidenceLedgerRef = useRef<EvidenceLedger | null>(null);
  const rxChunkSequenceRef = useRef(0);
  const txSequenceRef = useRef(0);
  const activeResponseRef = useRef<ResponseObservation | null>(null);
  const evidenceQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => { settingsRef.current = settings; saveStored(SETTINGS_KEY, settings); }, [settings]);
  useEffect(() => { saveStored(MACROS_KEY, macros); }, [macros]);
  useEffect(() => { saveStored(TELEMETRY_KEY, channels); }, [channels]);
  useEffect(() => { saveStored(PROFILES_KEY, profiles); }, [profiles]);
  useEffect(() => { saveStored(TESTS_KEY, tests); }, [tests]);
  useEffect(() => { activeTestRef.current = activeTest; }, [activeTest]);
  async function loadEnterpriseWorkspaces(): Promise<void> {
    if (!enterpriseUrl.trim() || !enterpriseToken.trim()) { setEnterpriseStatus("Enter the HTTPS control-plane URL and your OIDC access token."); return; }
    setEnterpriseBusy(true);
    try { const workspaceList = await listWorkspaces(enterpriseUrl.trim(), enterpriseToken.trim()); setEnterpriseWorkspaces(workspaceList); setEnterpriseWorkspaceId(workspaceList.some((workspace) => workspace.id === enterpriseWorkspaceId) ? enterpriseWorkspaceId : workspaceList[0]?.id || ""); setEnterpriseSession({ id: newId(), apiUrl: enterpriseUrl.trim(), token: enterpriseToken.trim() }); setEnterpriseStatus(`Connected. ${workspaceList.length} workspace(s) available.`); localStorage.setItem("wirepulse.enterprise-url", enterpriseUrl.trim()); setEnterpriseInvitations(await listMyInvitations(enterpriseUrl.trim(), enterpriseToken.trim()).catch(() => [])); }
    catch (error) { setEnterpriseStatus(`Enterprise connection failed: ${error instanceof EnterpriseApiError ? error.message : "network error"}`); }
    finally { setEnterpriseBusy(false); }
  }
  async function acceptEnterpriseInvitation(invitation: PendingInvitation): Promise<void> {
    setEnterpriseBusy(true);
    try { await acceptInvitation(enterpriseUrl.trim(), enterpriseToken.trim(), invitation.id); setEnterpriseInvitations((current) => current.filter((item) => item.id !== invitation.id)); setEnterpriseStatus(`Joined ${invitation.workspaceName} as ${invitation.role}. Reconnecting to refresh your workspaces.`); await loadEnterpriseWorkspaces(); }
    catch (error) { setEnterpriseStatus(`Could not accept the invitation: ${error instanceof EnterpriseApiError ? error.message : "network error"}`); }
    finally { setEnterpriseBusy(false); }
  }
  async function queueEnterpriseJob(): Promise<void> {
    if (!enterpriseWorkspaceId) { setEnterpriseStatus("Choose a workspace before queueing a gateway job."); return; }
    setEnterpriseBusy(true);
    try { const job = await createTestJob(enterpriseUrl.trim(), enterpriseToken.trim(), enterpriseWorkspaceId, { tests, profile: { settings, macros, channels } }, newId()); setEnterpriseStatus(`Queued gateway job ${job.id.slice(0, 8)}. Follow it in the enterprise console below; device bytes remain at the gateway.`); }
    catch (error) { setEnterpriseStatus(`Could not queue gateway job: ${error instanceof EnterpriseApiError ? error.message : "network error"}`); }
    finally { setEnterpriseBusy(false); }
  }
  async function createEnterpriseWorkspace(): Promise<void> {
    if (!enterpriseWorkspaceName.trim()) return;
    setEnterpriseBusy(true);
    try { const workspace = await createWorkspace(enterpriseUrl.trim(), enterpriseToken.trim(), enterpriseWorkspaceName.trim()); setEnterpriseWorkspaces((current) => [...current, workspace].sort((a, b) => a.name.localeCompare(b.name))); setEnterpriseWorkspaceId(workspace.id); setEnterpriseWorkspaceName(""); setEnterpriseStatus(`Created workspace ${workspace.name}.`); }
    catch (error) { setEnterpriseStatus(`Could not create workspace: ${error instanceof EnterpriseApiError ? error.message : "network error"}`); }
    finally { setEnterpriseBusy(false); }
  }
  async function shareCurrentProfile(): Promise<void> {
    if (!enterpriseWorkspaceId) { setEnterpriseStatus("Choose a workspace before sharing a profile."); return; }
    const name = profileName.trim() || "Untitled device profile";
    setEnterpriseBusy(true);
    try { await createResource(enterpriseUrl.trim(), enterpriseToken.trim(), enterpriseWorkspaceId, "profiles", name, { settings, macros, channels }); setEnterpriseStatus(`Shared profile “${name}” with the enterprise workspace.`); }
    catch (error) { setEnterpriseStatus(`Could not share profile: ${error instanceof EnterpriseApiError ? error.message : "network error"}`); }
    finally { setEnterpriseBusy(false); }
  }
  async function shareTestSuite(): Promise<void> {
    if (!enterpriseWorkspaceId) { setEnterpriseStatus("Choose a workspace before sharing a test suite."); return; }
    setEnterpriseBusy(true);
    try { await createResource(enterpriseUrl.trim(), enterpriseToken.trim(), enterpriseWorkspaceId, "test-suites", "WirePulse local validation suite", { tests }); setEnterpriseStatus("Shared the local test suite with the enterprise workspace."); }
    catch (error) { setEnterpriseStatus(`Could not share test suite: ${error instanceof EnterpriseApiError ? error.message : "network error"}`); }
    finally { setEnterpriseBusy(false); }
  }
  async function uploadTestReport(): Promise<void> {
    const evidence = evidenceLedgerRef.current?.bundle;
    if (!enterpriseWorkspaceId || !testResults.length) { setEnterpriseStatus("Choose a workspace and run at least one test before uploading a report."); return; }
    if (!evidence) { setEnterpriseStatus("Run the validation suite again to create a privacy-preserving evidence report before upload."); return; }
    setEnterpriseBusy(true);
    try {
      const passed = testResults.filter((result) => result.status === "passed").length;
      const failed = testResults.filter((result) => result.status === "failed").length;
      const response = await createTestReport(enterpriseUrl.trim(), enterpriseToken.trim(), enterpriseWorkspaceId, null, { passed, failed, total: testResults.length, evidenceSchema: evidence.schema, evidenceFinalHash: evidence.finalHash }, { results: testResults.map((result) => ({ testId: result.testId, status: result.status, attempts: result.attempts })), evidence });
      setEnterpriseStatus(`Uploaded aggregate report with ${response.evidenceVerification === "verified" ? "verified" : "unverified"} evidence. Raw serial logs and bytes were not uploaded.`);
    }
    catch (error) { setEnterpriseStatus(`Could not upload report: ${error instanceof EnterpriseApiError ? error.message : "network error"}`); }
    finally { setEnterpriseBusy(false); }
  }
  function updateTest(id: string, patch: Partial<TestDefinition>): void { setTests((current) => current.map((test) => test.id === id ? { ...test, ...patch } : test)); }
  function addTest(): void { setTests((current) => [...current, { id: newId(), name: "Untitled test", commands: "", expectedText: "", telemetryToken: "", telemetryOperator: ">=", telemetryValue: "", timeoutMs: 2000, retries: 0 }]); }
  function saveProfile(): void {
    const name = profileName.trim();
    if (!name) { addText("Enter a profile name before saving.", "system"); return; }
    const recordedAt = new Date().toISOString();
    const existing = profiles.find((profile) => profile.name.toLowerCase() === name.toLowerCase());
    const profile: DeviceProfile = { id: existing?.id ?? newId(), name, createdAt: existing?.createdAt ?? recordedAt, updatedAt: recordedAt, settings, macros, channels };
    setProfiles((current) => [...current.filter((item) => item.id !== profile.id), profile].sort((left, right) => left.name.localeCompare(right.name)));
    setProfileName("");
    addText(`Saved local device profile: ${name}`, "system");
  }
  function loadProfile(profile: DeviceProfile): void { setSettings({ ...DEFAULT_SETTINGS, ...profile.settings }); setMacros(profile.macros.length === 4 ? profile.macros : DEFAULT_MACROS); setChannels(normalizeChannels(profile.channels)); addText(`Loaded profile: ${profile.name}`, "system"); }
  function deleteProfile(id: string): void { const profile = profiles.find((item) => item.id === id); setProfiles((current) => current.filter((item) => item.id !== id)); if (profile) addText(`Deleted local profile: ${profile.name}`, "system"); }
  function exportProfiles(): void { download(JSON.stringify({ app: "WirePulse", version: 1, profiles }, null, 2), `wirepulse-profiles-${safeFileName()}.json`, "application/json"); }
  async function importProfiles(event: React.ChangeEvent<HTMLInputElement>): Promise<void> { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; try { const parsed = JSON.parse(await file.text()) as { profiles?: unknown }; if (!Array.isArray(parsed.profiles)) throw new Error("The file does not contain WirePulse profiles."); const imported = parsed.profiles.filter((profile): profile is DeviceProfile => Boolean(profile && typeof profile === "object" && typeof (profile as DeviceProfile).name === "string" && (profile as DeviceProfile).settings && Array.isArray((profile as DeviceProfile).macros) && Array.isArray((profile as DeviceProfile).channels))).map((profile) => ({ ...profile, id: newId(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })); setProfiles((current) => [...current, ...imported].sort((left, right) => left.name.localeCompare(right.name))); addText(`Imported ${imported.length} profile(s).`, "system"); } catch (error) { addText(`Could not import profiles: ${error instanceof Error ? error.message : "invalid file"}`, "system"); } }
  function exportTestReport(): void { const body = ["test,status,attempts,started_at,finished_at,detail", ...testResults.map((result) => [JSON.stringify(result.name), result.status, result.attempts, result.startedAt ? new Date(result.startedAt).toISOString() : "", result.finishedAt ? new Date(result.finishedAt).toISOString() : "", JSON.stringify(result.detail)].join(","))].join("\n"); download(body, `wirepulse-test-report-${safeFileName()}.csv`, "text/csv"); }
  function appendEvidence(type: EvidenceEventType, payload: Record<string, unknown>): Promise<void> {
    const append = async (): Promise<void> => {
      const ledger = evidenceLedgerRef.current;
      if (!ledger) return;
      const event = { sequence: ledger.bundle.events.length + 1, at: Date.now(), type, payload, previousHash: ledger.latestHash };
      const hash = await sha256(canonicalize(event));
      ledger.bundle.events.push({ ...event, hash });
      ledger.latestHash = hash;
      ledger.bundle.finalHash = hash;
    };
    evidenceQueueRef.current = evidenceQueueRef.current.then(append, append);
    return evidenceQueueRef.current;
  }
  async function finishEvidenceRun(type: "run.finished" | "run.stopped", results: TestResult[]): Promise<void> {
    const ledger = evidenceLedgerRef.current;
    if (!ledger) return;
    await appendEvidence(type, { results: results.map((result) => ({ testId: result.testId, status: result.status, attempts: result.attempts })) });
  }
  async function finishTest(status: "passed" | "failed", detail: string): Promise<void> {
    const active = activeTestRef.current;
    if (!active) return;
    if (testTimerRef.current) window.clearTimeout(testTimerRef.current);
    const observation = activeResponseRef.current;
    await appendEvidence("assertion.completed", { testId: active.test.id, attempt: active.attempt, status, assertionKind: active.test.telemetryToken.trim() ? "telemetry" : active.test.expectedText.trim() ? "text" : "any", response: responseEvidence(observation), staleLinesRejected: active.staleLines });
    setTestResults((current) => current.map((result, index) => index === active.resultIndex ? { ...result, status, finishedAt: Date.now(), detail, attempts: active.attempt } : result));
    setActiveTest(null);
    activeTestRef.current = null;
    activeResponseRef.current = null;
    window.setTimeout(() => void runNextTest(), 40);
  }
  async function executeTest(test: TestDefinition, resultIndex: number, attempt: number): Promise<void> {
    if (!connected || !port?.writable) {
      await appendEvidence("assertion.completed", { testId: test.id, attempt, status: "failed", assertionKind: test.telemetryToken.trim() ? "telemetry" : test.expectedText.trim() ? "text" : "any", response: null, staleLinesRejected: 0 });
      setTestResults((current) => current.map((result, index) => index === resultIndex ? { ...result, status: "failed", finishedAt: Date.now(), detail: "No active serial connection.", attempts: attempt } : result));
      window.setTimeout(() => void runNextTest(), 40);
      return;
    }
    const responseStartAt = Date.now();
    const active = { test, resultIndex, attempt, deadline: 0, responseWindowOpen: false, responseStartAt, responseStartRxSequence: rxChunkSequenceRef.current, staleLines: 0 };
    setActiveTest(active);
    activeTestRef.current = active;
    activeResponseRef.current = null;
    await appendEvidence("attempt.started", { testId: test.id, attempt, timeoutMs: test.timeoutMs, retries: test.retries, responseStartRxSequence: active.responseStartRxSequence });
    for (const command of test.commands.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      const receipt = await send(command, "test");
      if (receipt) await appendEvidence("command.transmitted", { testId: test.id, attempt, commandSequence: receipt.sequence, byteLength: receipt.byteLength, transmittedAt: receipt.at });
    }
    active.responseStartAt = Date.now();
    active.responseStartRxSequence = rxChunkSequenceRef.current;
    active.deadline = active.responseStartAt + Math.max(100, test.timeoutMs);
    active.responseWindowOpen = true;
    await appendEvidence("response.window.opened", { testId: test.id, attempt, startAt: active.responseStartAt, startRxSequence: active.responseStartRxSequence, deadline: active.deadline });
    testTimerRef.current = window.setTimeout(() => {
      const current = activeTestRef.current;
      if (!current || current.resultIndex !== resultIndex) return;
      void appendEvidence("attempt.timed_out", { testId: test.id, attempt, deadline: current.deadline, staleLinesRejected: current.staleLines });
      if (attempt <= test.retries) { void executeTest(test, resultIndex, attempt + 1); return; }
      void finishTest("failed", `Timed out after ${test.timeoutMs} ms.`);
    }, Math.max(100, test.timeoutMs));
  }
  function runNextTest(): void {
    setTestResults((results) => {
      const index = results.findIndex((result) => result.status === "not-run");
      if (index === -1) { setTestRunning(false); void finishEvidenceRun("run.finished", results); return results; }
      const test = tests.find((item) => item.id === results[index].testId);
      if (!test) return results;
      window.setTimeout(() => void executeTest(test, index, 1), 0);
      return results;
    });
  }
  async function runTests(): Promise<void> {
    if (!connected) { addText("Connect a device before running tests.", "system"); return; }
    if (testRunning) return;
    const fingerprints = { suite: await evidenceFingerprint(tests), profile: await evidenceFingerprint({ settings, macros, channels }), engine: await evidenceFingerprint({ engine: "wirepulse-test-engine", schema: "wirepulse.test-evidence.v1", version: 1 }) };
    const rootHash = await sha256(canonicalize({ schema: "wirepulse.test-evidence.v1", fingerprints }));
    evidenceLedgerRef.current = { bundle: { schema: "wirepulse.test-evidence.v1", evidenceId: newId(), createdAt: new Date().toISOString(), fingerprints, rootHash, events: [], finalHash: rootHash }, latestHash: rootHash };
    await appendEvidence("run.started", { testCount: tests.length });
    const initial = tests.map((test) => ({ testId: test.id, name: test.name, status: "not-run" as const, detail: "Waiting", attempts: 0 }));
    setTestResults(initial);
    setTestRunning(true);
    window.setTimeout(runNextTest, 0);
  }
  function stopTests(): void { if (testTimerRef.current) window.clearTimeout(testTimerRef.current); const active = activeTestRef.current; if (active) void appendEvidence("run.stopped", { testId: active.test.id, attempt: active.attempt }); activeResponseRef.current = null; setActiveTest(null); activeTestRef.current = null; setTestRunning(false); setTestResults((current) => { const stopped = current.map((result) => result.status === "not-run" ? { ...result, status: "failed" as const, detail: "Stopped by user." } : result); void finishEvidenceRun("run.stopped", stopped); return stopped; }); }
  function observeTestLine(text: string, receivedAt: number, chunkSequence: number, byteLength: number): void {
    const active = activeTestRef.current;
    if (!active) return;
    if (!active.responseWindowOpen || receivedAt < active.responseStartAt || chunkSequence <= active.responseStartRxSequence) { active.staleLines += 1; return; }
    const observation = activeResponseRef.current;
    activeResponseRef.current = observation ? { firstChunkSequence: observation.firstChunkSequence, lastChunkSequence: chunkSequence, byteLength: observation.byteLength + byteLength, observedAt: receivedAt } : { firstChunkSequence: chunkSequence, lastChunkSequence: chunkSequence, byteLength, observedAt: receivedAt };
    const { test } = active;
    const textMatches = !test.expectedText.trim() || text.toLowerCase().includes(test.expectedText.trim().toLowerCase());
    let telemetryMatches = !test.telemetryToken.trim() || !test.telemetryValue.trim();
    if (test.telemetryToken.trim() && test.telemetryValue.trim()) {
      const escaped = test.telemetryToken.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = text.match(new RegExp(`${escaped}\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)`, "i"));
      if (match) { const actual = Number(match[1]); const expected = Number(test.telemetryValue); telemetryMatches = test.telemetryOperator === ">=" ? actual >= expected : test.telemetryOperator === "<=" ? actual <= expected : actual === expected; } else telemetryMatches = false;
    }
    if (textMatches && telemetryMatches) void finishTest("passed", test.telemetryToken.trim() ? `Matched ${test.telemetryToken} ${test.telemetryOperator} ${test.telemetryValue}.` : `Matched text: ${test.expectedText || "any response"}.`);
  }
  const profileFileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { recordingRef.current = recording; }, [recording]);
  useEffect(() => { setLines((current) => current.slice(-settings.maxLines)); }, [settings.maxLines]);
  function changeSetting<K extends keyof Settings>(key: K, value: Settings[K]): void { setSettings((current) => ({ ...current, [key]: value })); }
  function rememberPort(selected: SerialPortLike): void { knownPortRef.current = selected; setKnownPort(selected); }

  function parseData(text: string): void {
    const detected: Array<{ id: number; value: number }> = [];
    channels.forEach((channel, id) => {
      if (!channel.enabled || !channel.token.trim()) return;
      const escaped = channel.token.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = text.match(new RegExp(`(?:^|\\s)${escaped}\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)`, "i"));
      if (match) detected.push({ id, value: Number(match[1]) });
    });
    if (detected.length) {
      const observedAt = Date.now();
      setPoints((current) => {
        const next = { ...current };
        for (const reading of detected) next[reading.id] = [...(next[reading.id] ?? []), { t: observedAt, value: reading.value }].slice(-80);
        return next;
      });
      const newAlerts = detected.flatMap((reading) => {
        const level = channelValueLevel(channels[reading.id], reading.value);
        return level ? [{ at: observedAt, id: reading.id, level, value: reading.value }] : [];
      });
      if (newAlerts.length) {
        setAlerts((current) => [...newAlerts, ...current].slice(0, 20));
        setWarnings((current) => current + newAlerts.filter((alert) => alert.level === "warning").length);
        setErrors((current) => current + newAlerts.filter((alert) => alert.level === "critical").length);
      }
    }
    if (!settingsRef.current.nmeaEnabled) return;
    const rmc = text.match(/\$(?:GPRMC|GNRMC),[^,]*,[AV],(\d+\.\d+),([NS]),(\d+\.\d+),([EW])/);
    if (rmc) setGps((current) => ({ ...current, lat: nmeaCoord(rmc[1], rmc[2]), lon: nmeaCoord(rmc[3], rmc[4]) }));
    const gga = text.match(/\$(?:GPGGA|GNGGA),[^,]*,[^,]*,[NS],[^,]*,[EW],\d,(\d+)/);
    if (gga) setGps((current) => ({ ...current, sats: gga[1] }));
  }

  function addText(text: string, direction: Direction = "rx", shouldRecord = true, receivedAt = Date.now(), chunkSequence?: number, byteLength?: number): void {
    if (paused && direction === "rx") return;
    const incoming = text.split(/\r?\n/).filter(Boolean).map((entry) => ({ time: now(), at: receivedAt, text: entry, direction }));
    if (!incoming.length) return;
    if (direction === "rx" && chunkSequence !== undefined) incoming.forEach((line) => observeTestLine(line.text, receivedAt, chunkSequence, byteLength ?? new TextEncoder().encode(line.text).length));
    const limit = settingsRef.current.maxLines;
    setLines((current) => [...current, ...incoming].slice(-limit));
    if (direction === "rx") {
      const levelCount = incoming.reduce((counts, line) => ({ errors: counts.errors + (lineLevel(line) === "error" ? 1 : 0), warnings: counts.warnings + (lineLevel(line) === "warning" ? 1 : 0) }), { errors: 0, warnings: 0 });
      if (levelCount.errors) setErrors((current) => current + levelCount.errors);
      if (levelCount.warnings) setWarnings((current) => current + levelCount.warnings);
      parseData(text);
    }
    if (shouldRecord && recordingRef.current) setRecordedLines((current) => [...current, ...incoming].slice(-limit));
  }

  async function detectBaud(selected: SerialPortLike): Promise<number> {
    const current = settingsRef.current;
    const probe = current.autoDetectProbe.trim();
    if (probe.length < 3) throw new Error("Auto detection needs an expected device word of at least 3 characters, such as READY or BOOT.");
    const candidates = BAUDS.filter((baud) => baud !== "auto").map(Number).reverse();
    setConnectionNote(`Testing baud rates for “${probe}”…`);
    for (const rate of candidates) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        await selected.open({ baudRate: rate, dataBits: current.dataBits, stopBits: current.stopBits, parity: current.parity, flowControl: current.flow });
        if (!selected.readable) throw new Error("No readable serial stream.");
        reader = selected.readable.getReader();
        const result = await Promise.race([reader.read(), new Promise<"timeout">((resolve) => window.setTimeout(() => resolve("timeout"), Math.max(250, current.autoDetectDwellMs)))]);
        if (result !== "timeout" && !result.done && result.value) {
          const received = new TextDecoder().decode(result.value);
          if (received.toLowerCase().includes(probe.toLowerCase())) { reader.releaseLock(); return rate; }
        }
      } catch { /* A device can reject an unsupported rate; try the next candidate. */ }
      finally { try { reader?.releaseLock(); await selected.close(); } catch { /* safe between attempts */ } }
    }
    throw new Error(`No supported baud rate produced “${probe}”. Confirm the device is already transmitting that word and try again.`);
  }
  async function openPort(selected: SerialPortLike, reconnecting = false): Promise<void> {
    const current = settingsRef.current;
    try {
      intentionalDisconnectRef.current = false;
      const detectedBaud = current.baud === "auto" ? await detectBaud(selected) : Number(current.baud);
      await selected.open({ baudRate: detectedBaud, dataBits: current.dataBits, stopBits: current.stopBits, parity: current.parity, flowControl: current.flow });
      rememberPort(selected);
      setPort(selected);
      setConnected(true);
      setConnectionNote(null);
      addText(`${reconnecting ? "Reconnected" : "Connected"} at ${detectedBaud} baud${current.baud === "auto" ? " (detected)" : ""}`, "system");
      void readLoop(selected);
    } catch (error) {
      setErrors((currentErrors) => currentErrors + 1);
      setConnectionNote(`Could not ${reconnecting ? "reconnect" : "open the port"}: ${error instanceof Error ? error.message : "unknown error"}`);
      addText(`Connection failed: ${error instanceof Error ? error.message : "unknown error"}`, "system");
    }
  }
  async function connect(): Promise<void> {
    const diagnostic = serialDiagnostic();
    if (diagnostic) { setConnectionNote(diagnostic); addText(diagnostic, "system"); return; }
    const selected = knownPortRef.current ?? await navigator.serial!.requestPort();
    await openPort(selected, Boolean(knownPortRef.current));
  }
  async function reconnect(): Promise<void> {
    if (!knownPortRef.current) { await connect(); return; }
    await openPort(knownPortRef.current, true);
  }
  async function readLoop(selected: SerialPortLike): Promise<void> {
    try {
      while (selected.readable) {
        const reader = selected.readable.getReader();
        readerRef.current = reader;
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            if (!result.value) continue;
            const receivedAt = Date.now();
            const chunkSequence = ++rxChunkSequenceRef.current;
            setRx((current) => current + result.value.length);
            if (recordingRef.current) setRawChunks((current) => [...current, { at: receivedAt, bytes: [...result.value] }].slice(-settingsRef.current.maxLines));
            const currentSettings = settingsRef.current;
            const frames = decodeFrames(result.value, currentSettings);
            frames.forEach((frame) => addText(frame, "system", true, receivedAt));
            if (currentSettings.format !== "ascii") { addText(decode(result.value, currentSettings.format), "rx", true, receivedAt, chunkSequence, result.value.length); continue; }
            decoderRef.current += textDecoderRef.current.decode(result.value, { stream: true });
            const chunks = decoderRef.current.split(/\r?\n/);
            decoderRef.current = chunks.pop() ?? "";
            for (const chunk of chunks) addText(chunk, "rx", true, receivedAt, chunkSequence, result.value.length);
          }
        } finally { reader.releaseLock(); if (readerRef.current === reader) readerRef.current = null; }
        break;
      }
    } catch (error) {
      if (!intentionalDisconnectRef.current) {
        setErrors((current) => current + 1);
        addText(`Read error: ${error instanceof Error ? error.message : "connection closed"}`, "system");
      }
    } finally {
      if (!intentionalDisconnectRef.current) {
        setConnected(false);
        setPort(null);
        setConnectionNote("Serial connection closed. Reconnect when the device is available.");
      }
    }
  }
  async function disconnect(): Promise<void> {
    intentionalDisconnectRef.current = true;
    if (replayTimerRef.current) window.clearTimeout(replayTimerRef.current);
    try { await readerRef.current?.cancel(); await port?.close(); } catch { /* port may already be closed */ }
    readerRef.current = null;
    setPort(null);
    setConnected(false);
    setConnectionNote("Disconnected. Your settings and macros are saved locally.");
    addText("Disconnected", "system");
  }
  async function send(value = input, source: "manual" | "test" = "manual"): Promise<SendReceipt | null> {
    if (!value || !port?.writable) return null;
    const bytes = new TextEncoder().encode(value + settingsRef.current.ending);
    const writer = port.writable.getWriter();
    try {
      await writer.write(bytes);
      const receipt = { sequence: ++txSequenceRef.current, at: Date.now(), byteLength: bytes.length };
      setTx((current) => current + bytes.length);
      addText(value, "tx");
      if (source === "manual") setInput("");
      return receipt;
    }
    catch (error) { setErrors((current) => current + 1); addText(`Transmit failed: ${error instanceof Error ? error.message : "unknown error"}`, "system"); return null; }
    finally { writer.releaseLock(); }
  }
  function exportLog(csv = false): void {
    const content = csv
      ? "timestamp,direction,text\n" + lines.map((line) => [new Date(line.at).toISOString(), line.direction, JSON.stringify(line.text)].join(",")).join("\n")
      : lines.map((line) => `[${line.time}] ${line.direction.toUpperCase()} ${line.text}`).join("\n");
    download(content, `wirepulse-${safeFileName()}.${csv ? "csv" : "txt"}`, csv ? "text/csv" : "text/plain");
  }
  function saveRecording(): void {
    const session: SessionFile = { app: "WirePulse", version: 2, recordedAt: new Date().toISOString(), lines: recordedLines, rawChunks };
    download(JSON.stringify(session, null, 2), `wirepulse-session-${safeFileName()}.json`, "application/json");
  }
  function exportRawCapture(): void {
    const content = rawChunks.map((chunk) => `${new Date(chunk.at).toISOString()} ${hexBytes(chunk.bytes)}`).join("\n");
    download(content, `wirepulse-raw-capture-${safeFileName()}.hex.txt`, "text/plain");
  }
  async function loadRecording(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as Partial<SessionFile>;
      if (!Array.isArray(parsed.lines) || parsed.lines.some((line) => typeof line?.text !== "string" || !["rx", "tx", "system"].includes(line.direction ?? ""))) throw new Error("The file is not a WirePulse session.");
      const restored = parsed.lines.map((line) => ({ time: typeof line.time === "string" ? line.time : now(), at: typeof line.at === "number" ? line.at : Date.now(), text: line.text, direction: line.direction as Direction }));
      setLoadedRecording(restored);
      addText(`Loaded recording with ${restored.length} lines. Use Replay to view it.`, "system", false);
    } catch (error) { setErrors((current) => current + 1); addText(`Could not load session: ${error instanceof Error ? error.message : "invalid file"}`, "system", false); }
  }
  function replayRecording(): void {
    const source = loadedRecording.length ? loadedRecording : recordedLines;
    if (!source.length || replaying) return;
    if (replayTimerRef.current) window.clearTimeout(replayTimerRef.current);
    setReplaying(true);
    setLines([]);
    setPoints({});
    let index = 0;
    const replayNext = (): void => {
      const line = source[index++];
      setLines((current) => [...current, line].slice(-settingsRef.current.maxLines));
      if (line.direction === "rx") parseData(line.text);
      if (index >= source.length) { setReplaying(false); replayTimerRef.current = null; return; }
      const pause = Math.min(350, Math.max(30, source[index].at - line.at || 80));
      replayTimerRef.current = window.setTimeout(replayNext, pause);
    };
    replayNext();
  }
  function stopReplay(): void {
    if (replayTimerRef.current) window.clearTimeout(replayTimerRef.current);
    replayTimerRef.current = null;
    setReplaying(false);
  }

  useEffect(() => {
    const serial = navigator.serial;
    if (!serial) return;
    void serial.getPorts?.().then((ports) => {
      if (ports[0]) { rememberPort(ports[0]); setConnectionNote("A previously permitted serial device is available. Select reconnect to use it."); }
    }).catch(() => undefined);
    const onDisconnect = (event: { port: SerialPortLike }) => {
      if (event.port !== knownPortRef.current) return;
      setConnected(false); setPort(null); setConnectionNote("The serial device was disconnected. Reconnect it, then select Reconnect.");
      addText("Serial device disconnected.", "system");
    };
    const onConnect = (event: { port: SerialPortLike }) => {
      if (event.port !== knownPortRef.current) return;
      setConnectionNote(settingsRef.current.autoReconnect ? "Serial device detected. Reconnecting…" : "Serial device detected. Select Reconnect when ready.");
      if (settingsRef.current.autoReconnect) window.setTimeout(() => { void reconnect(); }, 350);
    };
    serial.addEventListener?.("disconnect", onDisconnect);
    serial.addEventListener?.("connect", onConnect);
    return () => { serial.removeEventListener?.("disconnect", onDisconnect); serial.removeEventListener?.("connect", onConnect); };
  }, []);
  useEffect(() => { if (settings.autoscroll && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [lines, settings.autoscroll]);
  useEffect(() => () => { stopReplay(); void disconnect(); }, []);
  useEffect(() => {
    function keys(event: KeyboardEvent): void {
      if (!event.ctrlKey) return;
      if (event.key.toLowerCase() === "l") { event.preventDefault(); setLines([]); }
      if (event.key.toLowerCase() === "s") { event.preventDefault(); exportLog(); }
      if (event.key.toLowerCase() === "d") { event.preventDefault(); void disconnect(); }
      if (event.key.toLowerCase() === "f") { event.preventDefault(); document.getElementById("log-search")?.focus(); }
    }
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [lines, port]);

  const visibleLines = useMemo(() => lines.filter((line) => (directionFilter === "all" || line.direction === directionFilter) && (!search || line.text.toLowerCase().includes(search.toLowerCase()))), [lines, directionFilter, search]);
  const graphIds = useMemo(() => Object.keys(points).map(Number).sort((a, b) => a - b), [points]);
  const diagnostic = serialDiagnostic();
  const recordingSource = loadedRecording.length ? loadedRecording : recordedLines;

  return <main className={`app theme-${settings.theme.toLowerCase()}`}>
    <header>
      <div className="brand"><span className="wirepulse-logo" aria-hidden="true"><i></i><i></i><i></i></span><div><h1>WirePulse</h1><p>Browser serial monitor</p></div></div>
      <div className="header-actions"><span className="save-status">Settings saved locally</span><select aria-label="Theme" value={settings.theme} onChange={(event) => changeSetting("theme", event.target.value)}>{THEMES.map((theme) => <option key={theme}>{theme}</option>)}</select><a href="https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API" target="_blank" rel="noreferrer">Docs ↗</a></div>
    </header>
    <section className="stats">
      <div><b className="green">{rx.toLocaleString()}</b><span>RX bytes</span></div><div><b className="blue">{tx.toLocaleString()}</b><span>TX bytes</span></div><div><b>{lines.filter((line) => line.direction !== "system").length}</b><span>lines</span></div><div><b className="amber">{warnings}</b><span>warnings</span></div><div><b className="red">{errors}</b><span>errors</span></div>
      <div className="status"><i className={connected ? "online" : "offline"} />{connected ? "CONNECTED" : "OFFLINE"}</div>
    </section>
    {diagnostic && <div className="diagnostic" role="alert"><strong>Serial connection unavailable</strong><span>{diagnostic}</span></div>}
    <div className="workspace">
      <aside className="sidebar">
        <section><h2>Connection</h2><button className={connected ? "danger wide" : "primary wide"} onClick={() => connected ? void disconnect() : void connect()}>{connected ? "Disconnect" : knownPort ? "Reconnect saved device" : "Connect device"}</button>{!connected && knownPort && <button className="secondary wide reconnect" onClick={() => void reconnect()}>Reconnect</button>}<p className="connection-note" aria-live="polite">{connectionNote ?? "Serial API ready. Select a device to connect."}</p>
          <label>Baud rate<select value={settings.baud} onChange={(event) => changeSetting("baud", event.target.value)}>{BAUDS.map((baud) => <option key={baud} value={baud}>{baud === "auto" ? "Auto detect" : baud}</option>)}</select></label>{settings.baud === "auto" && <div className="auto-baud"><p>Auto mode tests common rates only when the device is already emitting this exact word.</p><input value={settings.autoDetectProbe} onChange={(event) => changeSetting("autoDetectProbe", event.target.value)} placeholder="Expected word, e.g. READY" /><label>Listen per rate (ms)<input type="number" min="250" max="5000" step="50" value={settings.autoDetectDwellMs} onChange={(event) => changeSetting("autoDetectDwellMs", Math.min(5000, Math.max(250, Number(event.target.value) || 250)))} /></label></div>}
          <div className="grid2"><label>Data bits<select value={settings.dataBits} onChange={(event) => changeSetting("dataBits", Number(event.target.value) as 7 | 8)}><option value={8}>8</option><option value={7}>7</option></select></label><label>Stop bits<select value={settings.stopBits} onChange={(event) => changeSetting("stopBits", Number(event.target.value) as 1 | 2)}><option value={1}>1</option><option value={2}>2</option></select></label></div>
          <div className="grid2"><label>Parity<select value={settings.parity} onChange={(event) => changeSetting("parity", event.target.value as SerialParity)}><option value="none">None</option><option value="even">Even</option><option value="odd">Odd</option></select></label><label>Flow control<select value={settings.flow} onChange={(event) => changeSetting("flow", event.target.value as SerialFlowControl)}><option value="none">None</option><option value="hardware">RTS/CTS</option></select></label></div>
          <label>Display format<select value={settings.format} onChange={(event) => changeSetting("format", event.target.value as Settings["format"])}><option value="ascii">ASCII</option><option value="hex">Hexadecimal</option><option value="binary">Binary</option></select></label><label>Line ending<select value={settings.ending} onChange={(event) => changeSetting("ending", event.target.value as Settings["ending"])}><option value="\n">LF</option><option value="\r">CR</option><option value="\r\n">CRLF</option><option value="">None</option></select></label>
          <label className="check"><input type="checkbox" checked={settings.autoReconnect} onChange={(event) => changeSetting("autoReconnect", event.target.checked)} /> Reconnect a known device</label>
        </section>
        <section className="decoder"><h2>Binary frame decoder</h2><p>Optionally identify raw frames between start and end bytes. This is a local inspection tool, not a claim that every protocol uses this framing.</p><label className="check"><input type="checkbox" checked={settings.binaryFrameEnabled} onChange={(event) => changeSetting("binaryFrameEnabled", event.target.checked)} /> Decode framed packets</label><div className="grid2"><label>Start byte<input value={settings.frameStart} maxLength={2} placeholder="AA" onChange={(event) => changeSetting("frameStart", event.target.value.toUpperCase())} /></label><label>End byte<input value={settings.frameEnd} maxLength={2} placeholder="55" onChange={(event) => changeSetting("frameEnd", event.target.value.toUpperCase())} /></label></div><label>Checksum<select value={settings.checksum} onChange={(event) => changeSetting("checksum", event.target.value as Settings["checksum"])}><option value="none">Do not validate</option><option value="xor">XOR: last payload byte</option></select></label></section>
        <section className="enterprise-panel"><div className="section-heading"><h2>Enterprise workspace</h2><span className="enterprise-tag">Optional</span></div><p>Connect only to your organization’s deployed HTTPS control plane. Tokens are kept in memory, never saved. Serial bytes and raw captures stay local unless you explicitly export them.</p><label>Control-plane URL<input value={enterpriseUrl} onChange={(event) => setEnterpriseUrl(event.target.value)} placeholder="https://api.wirepulse.example.com" /></label><label>OIDC access token<input type="password" autoComplete="off" value={enterpriseToken} onChange={(event) => setEnterpriseToken(event.target.value)} placeholder="Paste short-lived token" /></label><button className="secondary wide" disabled={enterpriseBusy} onClick={() => void loadEnterpriseWorkspaces()}>{enterpriseBusy ? "Connecting…" : "Connect workspace"}</button>{enterpriseWorkspaces.length > 0 && <><label>Active workspace<select value={enterpriseWorkspaceId} onChange={(event) => setEnterpriseWorkspaceId(event.target.value)}>{enterpriseWorkspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} · {workspace.role}</option>)}</select></label><div className="enterprise-share"><button disabled={enterpriseBusy} onClick={() => void shareCurrentProfile()}>Share profile</button><button disabled={enterpriseBusy} onClick={() => void shareTestSuite()}>Share tests</button><button disabled={enterpriseBusy} onClick={() => void queueEnterpriseJob()}>Queue gateway job</button></div></>}{enterpriseInvitations.length > 0 && <div className="enterprise-jobs" aria-label="Invitations for you">{enterpriseInvitations.map((invitation) => <div className="enterprise-job" key={invitation.id}><span><b>Invitation</b><small>{invitation.workspaceName} · {invitation.role}</small></span><button disabled={enterpriseBusy} onClick={() => void acceptEnterpriseInvitation(invitation)}>Accept</button></div>)}</div>}<div className="workspace-create"><input value={enterpriseWorkspaceName} onChange={(event) => setEnterpriseWorkspaceName(event.target.value)} placeholder="New workspace name" /><button disabled={enterpriseBusy || !enterpriseWorkspaceName.trim()} onClick={() => void createEnterpriseWorkspace()}>Create</button></div><p className="enterprise-status" aria-live="polite">{enterpriseStatus}</p></section>
        <section className="profiles"><div className="section-heading"><h2>Device profiles</h2><button className="link-button" onClick={exportProfiles} disabled={!profiles.length}>Export</button></div><p className="profile-copy">A profile stores local serial settings, macros, and telemetry dashboard configuration. No device logs or profile data leave this browser.</p><div className="profile-save"><input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="Profile name" onKeyDown={(event) => { if (event.key === "Enter") saveProfile(); }} /><button onClick={saveProfile}>Save</button></div>{profiles.length ? <div className="profile-list">{profiles.map((profile) => <div key={profile.id}><button className="profile-load" onClick={() => loadProfile(profile)}>{profile.name}</button><button className="profile-delete" aria-label={`Delete ${profile.name}`} onClick={() => deleteProfile(profile.id)}>×</button></div>)}</div> : <p className="profile-empty">No saved profiles.</p>}<button className="import-button" onClick={() => profileFileRef.current?.click()}>Import profiles</button><input ref={profileFileRef} type="file" accept="application/json,.json" onChange={(event) => void importProfiles(event)} hidden /></section>
        <section><div className="section-heading"><h2>Quick macros</h2><button className="link-button" onClick={() => setShowMacroEditor((current) => !current)}>{showMacroEditor ? "Done" : "Edit"}</button></div><div className="macro-grid">{macros.map((macro, index) => <button key={index} title={`Send: ${macro.command}`} onClick={() => void send(macro.command)} disabled={!connected || !macro.command}><kbd>M{index + 1}</kbd><span>{macro.label || `Macro ${index + 1}`}</span><b>▶</b></button>)}</div>{showMacroEditor && <div className="macro-editor">{macros.map((macro, index) => <div className="macro-fields" key={index}><input aria-label={`Macro ${index + 1} label`} value={macro.label} placeholder={`Macro ${index + 1}`} onChange={(event) => setMacros((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} /><input aria-label={`Macro ${index + 1} command`} value={macro.command} placeholder="Command" onChange={(event) => setMacros((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, command: event.target.value } : item))} /></div>)}</div>}</section>
        <section className="gps"><h2>GPS / NMEA</h2><label className="check"><input type="checkbox" checked={settings.nmeaEnabled} onChange={(event) => changeSetting("nmeaEnabled", event.target.checked)} /> Parse NMEA sentences</label><div className="gps-values"><span>Latitude <b>{gps.lat?.toFixed(6) ?? "—"}</b></span><span>Longitude <b>{gps.lon?.toFixed(6) ?? "—"}</b></span><span>Satellites <b>{gps.sats ?? "—"}</b></span></div></section>
      </aside>
      <section className="content">
        <div className="toolbar"><button onClick={() => setLines([])}>⌫ Clear</button><button onClick={() => setPaused((current) => !current)}>{paused ? "▶ Resume" : "Ⅱ Pause"}</button><button className={recording ? "recording" : ""} onClick={() => { setRecording((current) => !current); if (!recording) { setRecordedLines([]); setRawChunks([]); } }}>{recording ? "■ Stop recording" : "● Record session"}</button><label className="check"><input type="checkbox" checked={settings.autoscroll} onChange={(event) => changeSetting("autoscroll", event.target.checked)} /> Auto-scroll</label><span className="spacer" /><button onClick={() => exportLog()}>↓ TXT</button><button onClick={() => exportLog(true)}>↓ CSV</button></div>
        <div className="log-tools"><input id="log-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search logs (Ctrl+F)" /><select aria-label="Log direction filter" value={directionFilter} onChange={(event) => setDirectionFilter(event.target.value as "all" | Direction)}><option value="all">All messages</option><option value="rx">Received only</option><option value="tx">Transmitted only</option><option value="system">System only</option></select><label>Keep<select value={settings.maxLines} onChange={(event) => changeSetting("maxLines", Number(event.target.value))}>{[500, 1000, 2000, 5000, 10000].map((count) => <option key={count} value={count}>{count.toLocaleString()} lines</option>)}</select></label></div>
        <div className="terminal" ref={logRef}>{visibleLines.length === 0 ? <div className="empty"><strong>{lines.length ? "No matching log entries." : "Ready when you are."}</strong><span>{lines.length ? "Change or clear the active search and message filters." : "Connect a USB serial device to begin receiving data."}</span><small>Web Serial keeps communication local to your browser.</small></div> : visibleLines.map((line, index) => <div className={`line ${line.direction} ${lineLevel(line)}`} key={`${line.at}-${index}`}><time>{line.time}</time><b>{line.direction === "rx" ? "‹" : line.direction === "tx" ? "›" : "·"}</b><span>{highlightedText(line.text, search)}</span></div>)}</div>
        <div className="composer"><input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void send(); }} placeholder="Type a command and press Enter…" disabled={!connected} /><button onClick={() => void send()} disabled={!connected || !input}>Send ↵</button></div>
        <section className="test-panel"><div className="section-title"><div><h2>Hardware validation</h2><p>Run local command-and-response checks against the connected device.</p></div><div className="test-actions"><button onClick={addTest}>+ Test</button><button className="run-tests" onClick={testRunning ? stopTests : runTests} disabled={!tests.length}>{testRunning ? "Stop run" : "Run all"}</button></div></div><div className="test-editor"><div className="test-head"><span>Name</span><span>Commands (one per line)</span><span>Expected text</span><span>Telemetry assertion</span><span>Timeout / retries</span><span></span></div>{tests.map((test) => <div className="test-row" key={test.id}><input value={test.name} aria-label="Test name" onChange={(event) => updateTest(test.id, { name: event.target.value })} /><textarea value={test.commands} aria-label={`${test.name} commands`} placeholder="status" onChange={(event) => updateTest(test.id, { commands: event.target.value })} /><input value={test.expectedText} aria-label={`${test.name} expected text`} placeholder="READY" onChange={(event) => updateTest(test.id, { expectedText: event.target.value })} /><div className="assertion"><input value={test.telemetryToken} aria-label={`${test.name} telemetry token`} placeholder="VOLTAGE" onChange={(event) => updateTest(test.id, { telemetryToken: event.target.value.toUpperCase() })} /><select value={test.telemetryOperator} aria-label={`${test.name} telemetry operator`} onChange={(event) => updateTest(test.id, { telemetryOperator: event.target.value as TestDefinition["telemetryOperator"] })}><option value=">=">≥</option><option value="<=">≤</option><option value="=">=</option></select><input inputMode="decimal" value={test.telemetryValue} aria-label={`${test.name} telemetry value`} placeholder="12" onChange={(event) => updateTest(test.id, { telemetryValue: event.target.value })} /></div><div className="timing"><input type="number" min="100" step="100" value={test.timeoutMs} aria-label={`${test.name} timeout`} onChange={(event) => updateTest(test.id, { timeoutMs: Math.max(100, Number(event.target.value) || 100) })} /><input type="number" min="0" max="10" value={test.retries} aria-label={`${test.name} retries`} onChange={(event) => updateTest(test.id, { retries: Math.max(0, Number(event.target.value) || 0) })} /></div><button className="delete-test" aria-label={`Delete ${test.name}`} onClick={() => setTests((current) => current.filter((item) => item.id !== test.id))}>×</button></div>)}</div>{testResults.length > 0 && <div className="test-results"><div><h3>Latest test run</h3><span><button onClick={exportTestReport}>Export CSV</button><button disabled={enterpriseBusy || !enterpriseWorkspaceId} onClick={() => void uploadTestReport()}>Upload report</button></span></div>{testResults.map((result) => <p className={result.status} key={result.testId}><b>{result.status === "passed" ? "PASS" : result.status === "failed" ? "FAIL" : "WAIT"}</b><span>{result.name}</span><small>{result.detail} · attempt {result.attempts}</small></p>)}</div>}</section>
        {enterpriseSession && enterpriseWorkspaces.find((workspace) => workspace.id === enterpriseWorkspaceId) && <EnterpriseConsole key={`${enterpriseSession.id}|${enterpriseWorkspaceId}`} apiUrl={enterpriseSession.apiUrl} token={enterpriseSession.token} workspace={enterpriseWorkspaces.find((workspace) => workspace.id === enterpriseWorkspaceId)!} onWorkspaceDeleted={(deletedId) => { const remaining = enterpriseWorkspaces.filter((workspace) => workspace.id !== deletedId); setEnterpriseWorkspaces(remaining); setEnterpriseWorkspaceId(remaining[0]?.id ?? ""); setEnterpriseStatus("Workspace deleted. Your provider can restore it during the grace period."); }} />}
        <section className="session-panel"><div><h2>Session recordings</h2><p>{recording ? `Recording ${recordedLines.length} lines and ${rawChunks.length} raw chunks locally` : recordingSource.length ? `${recordingSource.length} lines ready for playback` : "Record, save, and replay local serial sessions"}</p></div><div className="session-actions"><button onClick={saveRecording} disabled={!recordedLines.length}>Save recording</button><button onClick={exportRawCapture} disabled={!rawChunks.length}>Export raw bytes</button><button onClick={() => fileRef.current?.click()}>Load recording</button><button onClick={replaying ? stopReplay : replayRecording} disabled={!recordingSource.length}>{replaying ? "Stop replay" : "Replay"}</button><input ref={fileRef} type="file" accept="application/json,.json" onChange={(event) => void loadRecording(event)} hidden /></div></section>
        <section className="telemetry"><div className="section-title"><div><h2>Telemetry dashboard</h2><p>Display values explicitly sent by your connected device; WirePulse has no built-in sensors.</p></div><div className="telemetry-actions"><span>{graphIds.length}/10 active</span><button onClick={() => setShowTelemetryEditor((current) => !current)}>{showTelemetryEditor ? "Done" : "Configure"}</button></div></div>{showTelemetryEditor && <div className="telemetry-editor"><p>Only the connected device supplies values. WirePulse recognizes each enabled <b>token</b> in messages such as <code>TEMP0: 24.5</code>; it does not measure temperature, location, or any other value itself. Warning and critical thresholds alert when an incoming value is greater than or equal to the configured value.</p><div className="channel-editor-head"><span>On</span><span>Token</span><span>Name</span><span>Unit</span><span>Warn ≥</span><span>Critical ≥</span></div>{channels.map((channel, index) => <div className="channel-editor-row" key={index}><input aria-label={`${channel.label} enabled`} type="checkbox" checked={channel.enabled} onChange={(event) => setChannels((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, enabled: event.target.checked } : item))} /><input aria-label={`Channel ${index + 1} token`} value={channel.token} onChange={(event) => setChannels((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, token: event.target.value.toUpperCase() } : item))} /><input aria-label={`Channel ${index + 1} name`} value={channel.label} onChange={(event) => setChannels((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} /><input aria-label={`Channel ${index + 1} unit`} value={channel.unit} onChange={(event) => setChannels((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, unit: event.target.value } : item))} /><input aria-label={`Channel ${index + 1} warning threshold`} inputMode="decimal" value={channel.warning} onChange={(event) => setChannels((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, warning: event.target.value } : item))} /><input aria-label={`Channel ${index + 1} critical threshold`} inputMode="decimal" value={channel.critical} onChange={(event) => setChannels((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, critical: event.target.value } : item))} /></div>)}</div>}{alerts.length > 0 && <div className="alert-panel"><div><h3>Live alerts</h3><button onClick={() => setAlerts([])}>Clear alerts</button></div>{alerts.slice(0, 4).map((alert, index) => <p className={alert.level} key={`${alert.at}-${index}`}><b>{alert.level === "critical" ? "Critical" : "Warning"}</b> · {channels[alert.id].label || channels[alert.id].token} reached {alert.value}{channels[alert.id].unit ? ` ${channels[alert.id].unit}` : ""}</p>)}</div>}{graphIds.length === 0 ? <div className="chart-empty">No telemetry channels yet. Send values like <code>TEMP0: 24.5</code> to see them here.</div> : <div className="charts">{graphIds.map((id) => { const values = points[id]; const channel = channels[id]; const max = Math.max(...values.map((point) => point.value), 1); const min = Math.min(...values.map((point) => point.value), 0); const range = Math.max(max - min, 1); const path = values.map((point, index) => `${index * 100 / Math.max(values.length - 1, 1)},${100 - ((point.value - min) / range) * 90 - 5}`).join(" "); const latest = values.at(-1)?.value; const level = latest === undefined ? null : channelValueLevel(channel, latest); return <div className={`chart ${level ?? ""}`} style={{ "--channel-color": CHANNEL_COLORS[id % CHANNEL_COLORS.length] } as React.CSSProperties} key={id}><div><span><b>{channel.label || channel.token}</b><small>{channel.token}{channel.unit ? ` · ${channel.unit}` : ""}</small></span><strong>{latest}{channel.unit ? ` ${channel.unit}` : ""}</strong></div><svg viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points={path} /></svg><footer><span>min {min.toFixed(2)}</span><span>max {max.toFixed(2)}</span><span>avg {(values.reduce((sum, point) => sum + point.value, 0) / values.length).toFixed(2)}</span></footer></div>; })}</div>}</section>
      </section>
    </div>
    <footer>WirePulse runs locally in your browser · Chrome or Edge required · Ctrl+F search · Ctrl+L clear · Ctrl+S export · Ctrl+D disconnect</footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
