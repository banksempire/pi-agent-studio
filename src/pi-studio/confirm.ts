import { reactive } from 'vue';

interface ConfirmState {
  open: boolean;
  title: string;
  text: string;
  confirmLabel: string;
  tone: 'accent' | 'danger';
  resolve: ((ok: boolean) => void) | null;
}

export const confirmState = reactive<ConfirmState>({
  open: false,
  title: '',
  text: '',
  confirmLabel: 'Confirm',
  tone: 'danger',
  resolve: null,
});

export function requestConfirm(opts: {
  title: string;
  text: string;
  confirmLabel?: string;
  tone?: 'accent' | 'danger';
}): Promise<boolean> {
  confirmState.resolve?.(false);
  confirmState.title = opts.title;
  confirmState.text = opts.text;
  confirmState.confirmLabel = opts.confirmLabel ?? 'Confirm';
  confirmState.tone = opts.tone ?? 'danger';
  confirmState.open = true;
  return new Promise((resolve) => {
    confirmState.resolve = resolve;
  });
}

export function settleConfirm(ok: boolean) {
  confirmState.open = false;
  confirmState.resolve?.(ok);
  confirmState.resolve = null;
}

export function confirmDocument() {
  return {
    title: confirmState.title,
    sections: [{ fields: [{ key: 'text', type: 'info' as const, text: confirmState.text }] }],
    actions: [
      { id: 'cancel', label: 'Cancel', close: true },
      { id: 'confirm', label: confirmState.confirmLabel, tone: confirmState.tone, close: true },
    ],
  };
}
