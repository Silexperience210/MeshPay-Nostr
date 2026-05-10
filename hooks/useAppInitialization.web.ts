import { useState, useEffect } from 'react';

interface InitState {
  isReady: boolean;
  isMigrating: boolean;
  error: string | null;
}

export function useAppInitialization(): InitState {
  const [state, setState] = useState<InitState>({
    isReady: false,
    isMigrating: false,
    error: null,
  });

  useEffect(() => {
    console.log('[Init-Web] Web platform - skipping native initialization');
    setState({
      isReady: true,
      isMigrating: false,
      error: null,
    });
  }, []);

  return state;
}
