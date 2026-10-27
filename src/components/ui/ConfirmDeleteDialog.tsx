import * as AlertDialog from '@radix-ui/react-alert-dialog';

export function ConfirmDeleteDialog({ open, onOpenChange, title, description, confirmLabel, onConfirm }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; confirmLabel: string; onConfirm: () => void;
}) {
  const focus = 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500';
  return <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
    <AlertDialog.Portal>
      <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/75" />
      <AlertDialog.Content className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100%-2rem)] max-w-md p-6 rounded-2xl bg-neutral-900 border border-neutral-700 text-neutral-100 shadow-2xl">
        <AlertDialog.Title className="text-base font-semibold text-white">{title}</AlertDialog.Title>
        <AlertDialog.Description className="mt-3 text-sm text-neutral-300 leading-relaxed">{description}</AlertDialog.Description>
        <div className="mt-6 flex justify-end gap-3">
          <AlertDialog.Cancel className={`px-4 py-2 rounded-xl border border-neutral-700 text-xs text-neutral-300 hover:bg-neutral-800 ${focus}`}>Отмена</AlertDialog.Cancel>
          <AlertDialog.Action onClick={onConfirm} className={`px-4 py-2 rounded-xl bg-white text-neutral-950 hover:bg-neutral-200 text-xs font-semibold ${focus}`}>{confirmLabel}</AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
}
