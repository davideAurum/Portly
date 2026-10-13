/**
 * UI kit (§10.4). Features import from here (or the individual files) and style with tokens only.
 */
export { Button, IconButton, type ButtonProps, type ButtonSize, type ButtonVariant, type IconButtonProps } from './Button.tsx';
export { Input, PasswordInput, Select, TextArea, type InputProps, type SelectOption, type SelectProps, type TextAreaProps } from './Input.tsx';
export { Checkbox, SegmentedControl, Slider, Switch, type SegmentedOption } from './Toggles.tsx';
export { Field, FieldGroup, useField, useFieldControlProps } from './Field.tsx';
export { ConfirmDialog, Dialog, DialogClose, type ConfirmDialogProps, type DialogProps } from './Dialog.tsx';
export { Popover, PopoverAnchor, PopoverClose, PopoverContent, PopoverTrigger } from './Popover.tsx';
export {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from './Menu.tsx';
export { Tooltip } from './Tooltip.tsx';
export { Tabs, TabsContent, TabsList, TabsTrigger } from './Tabs.tsx';
export { errorMessage, toast, toastError, toastUndo } from './toast.ts';
export { ColorPicker, ColorPickerPopover, normalizeHexInput } from './ColorPicker.tsx';
export { ImageUpload } from './ImageUpload.tsx';
export { Spinner } from './Spinner.tsx';
export { Skeleton, SkeletonLines, SkeletonList } from './Skeleton.tsx';
export { EmptyState, type EmptyStateProps } from './EmptyState.tsx';
export { ErrorState, QueryView, StaleIndicator, type QueryViewMeta, type QueryViewProps } from './ErrorState.tsx';
export { ErrorBoundary } from './ErrorBoundary.tsx';
export { Badge, Kbd, LetterTile, type BadgeTone } from './Badge.tsx';
export { ExternalLink } from './ExternalLink.tsx';
export { RelativeTime } from './RelativeTime.tsx';
export { Banner, type BannerTone } from './Banner.tsx';
export { CopyField } from './CopyField.tsx';
export { FactList, FieldGrid, FormFooter, SettingsCard } from './Section.tsx';
export { AccountBadge, accountColor } from './accounts/AccountBadge.tsx';
export { AccountPicker } from './accounts/AccountPicker.tsx';
export { ReconnectButton } from './accounts/ReconnectButton.tsx';
export { ACCOUNT_KIND_LABELS, CAPABILITY_ICONS, CAPABILITY_LABELS } from './accounts/accountKinds.ts';
