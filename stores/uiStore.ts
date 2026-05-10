/**
 * UI Store - Gestion des états UI globaux
 * Loading states, erreurs, modals
 */
import { create } from 'zustand';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ModalType = 
  | 'receive'
  | 'send'
  | 'checkout'
  | 'nfc'
  | 'nfcBackup'
  | 'productForm'
  | 'review'
  | 'deviceSettings'
  | 'gatewayScan'
  | 'meshStats'
  | 'repeaterConfig'
  | 'roomServerConfig'
  | 'usbSerialScan'
  | 'tip'
  | 'welcome'
  | null;

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

export interface UIState {
  // Loading states
  isLoading: boolean;
  loadingMessage: string | null;
  loadingProgress: number | null;
  
  // Errors
  error: Error | null;
  errorMessage: string | null;
  
  // Modals
  activeModal: ModalType;
  modalData: Record<string, any> | null;
  
  // Toasts
  toasts: Toast[];
  
  // Actions
  setLoading: (loading: boolean, message?: string | null, progress?: number | null) => void;
  updateLoadingProgress: (progress: number) => void;
  clearLoading: () => void;
  
  showError: (error: Error | string) => void;
  clearError: () => void;
  
  openModal: (modal: ModalType, data?: Record<string, any>) => void;
  closeModal: () => void;
  toggleModal: (modal: ModalType, data?: Record<string, any>) => void;
  
  addToast: (message: string, type?: ToastType, duration?: number) => string;
  removeToast: (id: string) => void;
  clearToasts: () => void;
  
  // Helpers
  isModalOpen: (modal: ModalType) => boolean;
  getModalData: <T = any>() => T | null;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useUIStore = create<UIState>()((set, get) => ({
  // Initial state
  isLoading: false,
  loadingMessage: null,
  loadingProgress: null,
  
  error: null,
  errorMessage: null,
  
  activeModal: null,
  modalData: null,
  
  toasts: [],

  // Loading actions
  setLoading: (loading: boolean, message: string | null = null, progress: number | null = null) => {
    set({
      isLoading: loading,
      loadingMessage: loading ? message : null,
      loadingProgress: loading ? progress : null,
    });
  },

  updateLoadingProgress: (progress: number) => {
    set({ loadingProgress: progress });
  },

  clearLoading: () => {
    set({
      isLoading: false,
      loadingMessage: null,
      loadingProgress: null,
    });
  },

  // Error actions
  showError: (error: Error | string) => {
    const errorMessage = error instanceof Error ? error.message : error;
    const errorObj = error instanceof Error ? error : new Error(errorMessage);
    
    console.error('[UIStore] Error:', errorMessage);
    set({ error: errorObj, errorMessage });
    
    // Auto-ajouter un toast pour l'erreur
    get().addToast(errorMessage, 'error', 5000);
  },

  clearError: () => {
    set({ error: null, errorMessage: null });
  },

  // Modal actions
  openModal: (modal: ModalType, data?: Record<string, any>) => {
    console.log('[UIStore] Opening modal:', modal);
    set({ activeModal: modal, modalData: data || null });
  },

  closeModal: () => {
    console.log('[UIStore] Closing modal');
    set({ activeModal: null, modalData: null });
  },

  toggleModal: (modal: ModalType, data?: Record<string, any>) => {
    const { activeModal } = get();
    if (activeModal === modal) {
      get().closeModal();
    } else {
      get().openModal(modal, data);
    }
  },

  // Toast actions
  addToast: (message: string, type: ToastType = 'info', duration: number = 3000): string => {
    const id = Math.random().toString(36).substring(2, 9);
    const toast: Toast = { id, message, type, duration };
    
    set((state) => ({
      toasts: [...state.toasts, toast],
    }));

    // Auto-remove après duration
    if (duration > 0) {
      setTimeout(() => {
        get().removeToast(id);
      }, duration);
    }

    return id;
  },

  removeToast: (id: string) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },

  clearToasts: () => {
    set({ toasts: [] });
  },

  // Helpers
  isModalOpen: (modal: ModalType): boolean => {
    return get().activeModal === modal;
  },

  getModalData: <T = any>(): T | null => {
    return get().modalData as T | null;
  },
}));

// ─── Hooks utilitaires ───────────────────────────────────────────────────────

export function useLoading() {
  return useUIStore((state) => ({
    isLoading: state.isLoading,
    message: state.loadingMessage,
    progress: state.loadingProgress,
  }));
}

export function useError() {
  return useUIStore((state) => ({
    error: state.error,
    message: state.errorMessage,
  }));
}

export function useModal(modalType?: ModalType) {
  const store = useUIStore();
  return {
    isOpen: modalType ? store.activeModal === modalType : store.activeModal !== null,
    activeModal: store.activeModal,
    data: store.modalData,
    open: (data?: Record<string, any>) => store.openModal(modalType || store.activeModal, data),
    close: store.closeModal,
    toggle: (data?: Record<string, any>) => store.toggleModal(modalType || store.activeModal, data),
  };
}

export function useToasts() {
  return useUIStore((state) => ({
    toasts: state.toasts,
    add: state.addToast,
    remove: state.removeToast,
    clear: state.clearToasts,
  }));
}

export function useUIActions() {
  const store = useUIStore();
  return {
    setLoading: store.setLoading,
    updateLoadingProgress: store.updateLoadingProgress,
    clearLoading: store.clearLoading,
    showError: store.showError,
    clearError: store.clearError,
    openModal: store.openModal,
    closeModal: store.closeModal,
    toggleModal: store.toggleModal,
    addToast: store.addToast,
    removeToast: store.removeToast,
    clearToasts: store.clearToasts,
  };
}
