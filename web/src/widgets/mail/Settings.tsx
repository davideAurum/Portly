/**
 * Mail widget settings (§10.8): accounts (all or a subset of the mail-enabled ones), how many
 * messages to show, unread only, and merged vs by-account layout.
 */
import { MAX_MAIL_MESSAGES, MIN_MAIL_MESSAGES } from '@homebase/shared';
import { AccountPicker } from '../../ui/accounts/AccountPicker.tsx';
import { Field } from '../../ui/Field.tsx';
import { SegmentedControl, Slider, Switch } from '../../ui/Toggles.tsx';
import type { WidgetSettingsProps } from '../types.ts';
import type { MailConfig } from './index.ts';
import styles from './Mail.module.css';

const GROUPING_OPTIONS = [
  { value: 'merged', label: 'Newest first' },
  { value: 'byAccount', label: 'By account' },
] as const;

export default function MailSettings({ value, onChange }: WidgetSettingsProps<MailConfig>) {
  const set = (patch: Partial<MailConfig>) => onChange({ ...value, ...patch });

  return (
    <div className={styles.settings}>
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>
          Accounts
        </legend>
        <AccountPicker capability="mail" value={value.accountIds} onChange={(accountIds) => set({ accountIds })} />
      </fieldset>

      <Field label="Layout" help={value.grouping === 'merged' ? 'All accounts in one list, newest first.' : 'A section per account.'}>
        <SegmentedControl<MailConfig['grouping']> value={value.grouping} onValueChange={(grouping) => set({ grouping })} options={GROUPING_OPTIONS} block />
      </Field>

      <Field
        label="Messages to show"
        help={value.grouping === 'byAccount' ? 'The most recent messages of each account.' : 'The most recent messages across your accounts.'}
      >
        <Slider
          min={MIN_MAIL_MESSAGES}
          max={MAX_MAIL_MESSAGES}
          value={value.maxMessages}
          onChange={(maxMessages) => set({ maxMessages })}
          format={(n) => `${n} messages`}
        />
      </Field>

      <Switch
        label="Unread only"
        description="Hide messages you have already read."
        checked={value.unreadOnly}
        onCheckedChange={(unreadOnly) => set({ unreadOnly })}
      />
    </div>
  );
}
