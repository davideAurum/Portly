/** CopyField: a read-only value (e.g. an OAuth redirect URI) with a Copy button. */
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyText } from '../lib/clipboard.ts';
import { useFieldControlProps } from './Field.tsx';
import { toast } from './toast.ts';
import styles from './Display.module.css';

export interface CopyFieldProps {
  value: string;
  id?: string;
  /** What is being copied, for the button label and toast ("Redirect URI"). */
  label?: string;
  monospace?: boolean;
}

export function CopyField({ value, id, label = 'Value', monospace = true }: CopyFieldProps) {
  const fieldProps = useFieldControlProps({ id });
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (await copyText(value)) {
      setCopied(true);
      toast.success(`${label} copied.`);
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error('Copy failed — select the text and copy it manually.');
    }
  };

  return (
    <div className={styles.copyField}>
      <input
        {...fieldProps}
        readOnly
        value={value}
        className={styles.copyInput}
        data-mono={monospace ? 'true' : undefined}
        onFocus={(event) => event.currentTarget.select()}
      />
      <button type="button" className={styles.copyButton} onClick={() => void copy()} aria-label={`Copy ${label.toLowerCase()}`}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  );
}
