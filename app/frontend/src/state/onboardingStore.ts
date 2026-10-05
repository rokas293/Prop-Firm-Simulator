// First-run explainer state (FXR phase F7b). `dismissed` persists (the card on
// the Sessions list shows once, until dismissed); `tourOpen` is session-local
// -- it only drives the re-opened dialog ("?" overlay -> "Show the quick tour").
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface OnboardingState {
  dismissed: boolean
  tourOpen: boolean
  dismiss: () => void
  openTour: () => void
  closeTour: () => void
}

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set) => ({
      dismissed: false,
      tourOpen: false,
      dismiss: () => set({ dismissed: true }),
      openTour: () => set({ tourOpen: true }),
      closeTour: () => set({ tourOpen: false, dismissed: true }),
    }),
    { name: 'propbt-viz:onboarding', partialize: (s) => ({ dismissed: s.dismissed }) },
  ),
)
