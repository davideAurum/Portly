/**
 * Diagnostics → Report (ARCHITECTURE §17): "Download diagnostic report" saves the server's report
 * with this browser's section added (`report.ts`), and "Copy summary" copies a plain-text digest of
 * at most 40 lines (`summaryText.ts`). "Hide hosts, emails and names (for sharing publicly)" —
 * off by default: the full detail is what helps — redacts both with `redactForSharing`: the server
 * redacts its report, this page the browser section and the summary.
 */
import { useState } from 'react';
import { Copy, Download } from 'lucide-react';
import { redactForSharing, type DiagnosticsSummary, type LogRecord } from '@portly/shared';
import { getDiagnosticsLogs } from '../../api/diagnostics.ts';
import { getCapabilities } from '../../capabilities.ts';
import { copyText } from '../../lib/clipboard.ts';
import { useLocalServer } from '../../localServer/store.ts';
import { Button } from '../../ui/Button.tsx';
import { SettingsCard } from '../../ui/Section.tsx';
import { toast, toastError } from '../../ui/toast.ts';
import { Checkbox } from '../../ui/Toggles.tsx';
import { clientPageInfo, clientSessionId, getClientEvents } from '../clientLog.ts';
import { browserReportSection, saveDiagnosticReport, sharingDictionary } from './report.ts';
import { buildSummaryText } from './summaryText.ts';
import styles from './Diagnostics.module.css';

export interface ReportPanelProps {
  summary: DiagnosticsSummary | null;
  /** Why there is no summary (shown in the copied text). */
  summaryProblem?: string | null;
  /** Account labels and emails, for redaction. */
  accounts: readonly { label: string; email: string | null }[];
}

export function ReportPanel({ summary, summaryProblem = null, accounts }: ReportPanelProps) {
  const [redact, setRedact] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [copying, setCopying] = useState(false);
  const localServer = useLocalServer();

  const pagesOrigin = () => (getCapabilities().pagesBuild ? window.location.origin : null);
  const dictionary = () => sharingDictionary({ summary, accounts, pagesOrigin: pagesOrigin(), events: getClientEvents() });

  const download = async () => {
    setDownloading(true);
    try {
      const caps = getCapabilities();
      const browser = browserReportSection({
        caps,
        version: clientPageInfo().version,
        origin: window.location.origin,
        userAgent: navigator.userAgent,
        session: clientSessionId(),
        localServer: caps.pagesBuild ? localServer : null,
        events: getClientEvents(),
      });
      const filename = await saveDiagnosticReport({ redact, browser, dict: dictionary() });
      toast.success(`Saved ${filename}.`);
    } catch (error) {
      toastError(error, 'The diagnostic report could not be downloaded.');
    } finally {
      setDownloading(false);
    }
  };

  const copy = async () => {
    setCopying(true);
    try {
      let serverRecords: LogRecord[] | null = null;
      if (summary !== null) {
        try {
          serverRecords = (await getDiagnosticsLogs({ scope: 'memory', level: 'warn', limit: 500 })).records;
        } catch {
          // The summary still helps without the recent warnings.
        }
      }
      const caps = getCapabilities();
      const text = buildSummaryText({
        now: new Date(),
        summary,
        summaryProblem,
        page: clientPageInfo(),
        hybrid: caps.pagesBuild ? { status: localServer.status, permission: localServer.permission } : null,
        serverRecords,
        browserEvents: getClientEvents(),
      });
      const shared = redact ? String(redactForSharing(text, dictionary())) : text;
      if (await copyText(shared)) toast.success('Summary copied.');
      else toast.error('Copy failed — your browser did not allow it.');
    } finally {
      setCopying(false);
    }
  };

  return (
    <SettingsCard
      id="diagnostics-report"
      title="Diagnostic report"
      description="Everything on this page plus the server's recent log, as a file to keep or send when asking for help. It never contains passwords, tokens or the contents of your mail, calendars or tasks; Windows user names in paths are masked."
    >
      <Checkbox
        label="Hide hosts, emails and names (for sharing publicly)"
        description="Replaces server addresses, email addresses, account and calendar names with placeholders such as host#1 in the report and the summary."
        checked={redact}
        onCheckedChange={setRedact}
      />
      <div className={styles.inlineRow}>
        <Button variant="primary" icon={Download} loading={downloading} onClick={() => void download()}>
          Download diagnostic report
        </Button>
        <Button icon={Copy} loading={copying} onClick={() => void copy()}>
          Copy summary
        </Button>
      </div>
    </SettingsCard>
  );
}
