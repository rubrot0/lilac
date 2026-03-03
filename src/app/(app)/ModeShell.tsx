'use client'

import type { ReactNode } from 'react'

import ChatMode from '@/app/(app)/ChatMode'
import TranslateMode from '@/app/(app)/TranslateMode'
import { useLilacModeRuntime } from '@/realtime/modeRuntimeStore'
import type { LilacMode } from '@/realtime/sessionTypes'

function renderMode(mode: LilacMode): ReactNode {
	switch (mode) {
		case 'chat':
			return <ChatMode />
		case 'translate':
			return <TranslateMode />
		default:
			return <ChatMode />
	}
}

function getConnectionStateLabel(connectionState: string): string {
	switch (connectionState) {
		case 'connecting':
			return 'Connecting'
		case 'connected':
			return 'Live'
		case 'error':
			return 'Error'
		default:
			return 'Idle'
	}
}

export default function ModeShell() {
	const {
		clearCurrentModeHistory,
		connectionState,
		errorMessage,
		mode,
		reconnectCurrentMode,
		setMode,
		setVoiceInputEnabled,
		voiceInputEnabled
	} = useLilacModeRuntime()

	return (
		<div className="relative min-h-[100dvh] bg-[var(--lilac-surface)]">
			<div className="-z-10 pointer-events-none absolute inset-0 bg-[radial-gradient(140%_110%_at_50%_-8%,rgba(248,252,255,0.95)_0%,rgba(236,244,255,0.86)_28%,rgba(231,237,246,0.4)_55%,rgba(231,237,246,0)_80%)] dark:bg-[radial-gradient(150%_120%_at_50%_-8%,rgba(57,80,112,0.45)_0%,rgba(26,39,57,0.35)_34%,rgba(14,19,29,0)_80%)]" />
			<div className="relative z-10 flex min-h-[100dvh] flex-col">
				<header className="sticky top-0 z-20 border-[var(--lilac-border)] border-b bg-[color-mix(in_oklab,var(--lilac-surface)_86%,transparent)] px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur sm:px-6">
					<div className="mx-auto flex w-full max-w-5xl flex-col gap-3">
						<div className="flex items-center justify-between gap-3">
							<div className="font-semibold text-[var(--lilac-ink-muted)] text-xs uppercase tracking-[0.18em]">
								Lilac
							</div>
							<div className="flex items-center gap-2">
								<div
									className="rounded-full border border-[var(--lilac-border)] bg-[var(--lilac-elevated)] px-3 py-1 font-semibold text-[10px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.14em]"
									data-testid="mode-active-badge"
								>
									{mode}
								</div>
								<div
									className="rounded-full border border-[var(--lilac-border)] bg-[var(--lilac-elevated)] px-3 py-1 font-semibold text-[10px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.14em]"
									data-testid="connection-state-badge"
								>
									{getConnectionStateLabel(connectionState)}
								</div>
							</div>
						</div>

						<div className="flex items-center justify-between gap-2 rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-elevated)] p-1">
							<div className="flex items-center gap-1" role="tablist">
								{(['chat', 'translate'] as const).map(modeOption => (
									<button
										key={modeOption}
										type="button"
										aria-pressed={mode === modeOption}
										data-testid={`mode-tab-${modeOption}`}
										className={`cursor-pointer rounded-xl px-3 py-2 font-semibold text-xs uppercase tracking-[0.1em] transition ${
											mode === modeOption
												? 'bg-[var(--lilac-ink)] text-[var(--lilac-surface)]'
												: 'text-[var(--lilac-ink-muted)] hover:bg-[var(--lilac-card-muted)] hover:text-[var(--lilac-ink)]'
										}`}
										onClick={() => setMode(modeOption)}
									>
										{modeOption === 'translate' ? 'Live Translate' : 'Chat'}
									</button>
								))}
							</div>

							<button
								type="button"
								aria-pressed={voiceInputEnabled}
								data-testid="global-voice-input-toggle"
								className={`cursor-pointer rounded-xl px-3 py-2 font-semibold text-xs uppercase tracking-[0.1em] transition ${
									voiceInputEnabled
										? 'bg-[var(--lilac-direction-primary)] text-white'
										: 'bg-[var(--lilac-card-muted)] text-[var(--lilac-ink-muted)]'
								}`}
								onClick={() => setVoiceInputEnabled(!voiceInputEnabled)}
							>
								Voice {voiceInputEnabled ? 'On' : 'Off'}
							</button>
						</div>

						<div className="flex items-center justify-end gap-2">
							<button
								type="button"
								data-testid="clear-mode-history"
								className="cursor-pointer rounded-xl border border-[var(--lilac-border)] bg-[var(--lilac-elevated)] px-3 py-2 font-semibold text-[10px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.14em] transition hover:bg-[var(--lilac-card-muted)]"
								onClick={clearCurrentModeHistory}
							>
								Clear
							</button>
							<button
								type="button"
								data-testid="reconnect-mode"
								className="cursor-pointer rounded-xl bg-[var(--lilac-ink)] px-4 py-2 font-semibold text-[10px] text-[var(--lilac-surface)] uppercase tracking-[0.14em] transition hover:opacity-90"
								onClick={reconnectCurrentMode}
							>
								Reconnect
							</button>
						</div>
					</div>
				</header>

				<main className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-3 px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
					{errorMessage ? (
						<div
							className="rounded-2xl border border-red-500/45 bg-red-100/70 px-4 py-3 text-red-900 text-sm dark:bg-red-950/35 dark:text-red-100"
							data-testid="mode-error-banner"
						>
							{errorMessage}
						</div>
					) : null}

					<div className="flex min-h-0 flex-1 flex-col">{renderMode(mode)}</div>
				</main>
			</div>
		</div>
	)
}
