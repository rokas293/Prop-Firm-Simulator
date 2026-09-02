// One shared visual language for every menu/dropdown/popover in the app
// (REPLICA_ROADMAP.md Batch 5: "unify the popover/menu/tooltip system").
// Before this, each of ~8 hand-rolled popovers (ContextMenu,
// DrawingStylePopover, IndicatorSettingsPopover, KLDrawingToolbar's three
// flyouts, TimeframeMenu, ChartLayoutMenu, Workspace's "+Panel" menu) wrote
// its own `rounded border border-border bg-surface-2 ... shadow-lg` by
// hand, and NONE of them had an open transition at all -- only the cmdk-
// based modals (.propbt-cmdk-content in index.css) did. Two genuinely
// different content shapes remain (a list of clickable rows vs a small
// form of labeled fields), so this exports both, not one -- but every
// popover now shares the same shell/motion regardless of which shape it
// uses inside.
//
// POPOVER_SHELL: the outer container. Deliberately carries no z-index --
// callers need different stacking (a right-click menu that must sit above
// other popovers vs. a toolbar flyout), and two z-* utilities in one
// className string race on Tailwind's OWN generated-CSS order, not JSX
// order, so mixing one in here would be a silent footgun. Compose with
// your own z-*, width (w-48/w-64/...), and an inner padding choice below.
export const POPOVER_SHELL = 'propbt-fade-in rounded border border-border bg-surface-2 text-xs shadow-lg'

// A list of full-width clickable rows (ContextMenu, the drawing toolbar's
// group/favorites/manage flyouts) -- the shell above still needs its own
// `py-1` (this is per-ROW padding, not the list's own top/bottom inset).
export const POPOVER_MENU_ROW =
  'flex w-full items-center px-3 py-1.5 text-left text-text hover:bg-surface-2-hover disabled:cursor-not-allowed disabled:text-text-muted disabled:opacity-50'

// A small form of labeled fields (DrawingStylePopover, IndicatorSettingsPopover,
// ChartLayoutMenu) -- one flat padding on the shell itself, no per-row rhythm.
export const POPOVER_FORM_PADDING = 'p-3'
