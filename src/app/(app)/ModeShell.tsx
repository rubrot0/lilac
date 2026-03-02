'use client'

import type { ReactNode } from 'react'

import ChatMode from '@/app/(app)/ChatMode'
import TranscribeMode from '@/app/(app)/TranscribeMode'
import TranslateMode from '@/app/(app)/TranslateMode'
import { useLilacModeRuntime } from '@/realtime/modeRuntimeStore'
import type { LilacMode } from '@/realtime/sessionTypes'

function renderMode(mode: LilacMode): ReactNode {
	switch (mode) {
		case 'chat':
			return <ChatMode />
		case 'translate':
			return <TranslateMode />
		case 'transcribe':
			return <TranscribeMode />
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
		setMode
	} = useLilacModeRuntime()

	return (
		<div className="relative flex h-svh flex-col overflow-hidden">
			<div className="-z-10 pointer-events-none absolute inset-0 bg-[radial-gradient(220%_200%_at_50%_-12%,rgba(255,255,255,0.96)_0%,rgba(247,243,231,0.98)_48%,rgba(247,243,231,1)_72%,rgba(188,226,255,0.65)_100%)] dark:bg-[radial-gradient(220%_200%_at_50%_-12%,rgba(33,39,56,0.95)_0%,rgba(18,22,32,0.98)_52%,rgba(14,18,27,1)_78%,rgba(39,55,92,0.62)_100%)]" />
			<div className="-z-10 pointer-events-none absolute inset-x-0 top-0 h-[26dvh] bg-gradient-to-b from-white/65 via-transparent to-transparent dark:from-[#27324a]/50" />
			<div className="-z-10 pointer-events-none absolute inset-x-0 bottom-0 h-[30dvh] bg-gradient-to-t from-[var(--lilac-surface)] via-transparent to-transparent" />

			<header
				className="absolute inset-x-0 z-20 flex items-center justify-between px-6"
				style={{ top: 'calc(env(safe-area-inset-top, 0px) + 1.5rem)' }}
			>
				<div className="font-semibold text-[var(--lilac-ink-muted)] text-sm uppercase tracking-[0.16em]">
					Lilac
				</div>
				<div className="rounded-full border border-white/25 bg-[var(--lilac-elevated)] p-1 shadow backdrop-blur">
					<div className="flex items-center gap-1" role="tablist">
						{(['chat', 'translate', 'transcribe'] as const).map(modeOption => (
							<button
								key={modeOption}
								type="button"
								aria-pressed={mode === modeOption}
								className={`cursor-pointer rounded-full px-3 py-2 font-semibold text-xs uppercase tracking-[0.08em] transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2 ${
									mode === modeOption
										? 'bg-white text-[var(--lilac-ink)] shadow'
										: 'text-[var(--lilac-ink-muted)] hover:text-[var(--lilac-ink)]'
								}`}
								onClick={() => setMode(modeOption)}
							>
								{modeOption}
							</button>
						))}
					</div>
				</div>
			</header>

			<div className="relative z-10 flex flex-1 items-center justify-center px-6 pt-28 pb-24">
				<div className="flex w-full max-w-6xl flex-col gap-4">
					<div className="flex items-center justify-between gap-4">
						<div className="rounded-full border border-white/25 bg-[var(--lilac-elevated)] px-3 py-1 font-semibold text-[10px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.14em] shadow-sm">
							{mode}
						</div>
						<div className="rounded-full border border-white/25 bg-[var(--lilac-elevated)] px-3 py-1 font-semibold text-[10px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.14em] shadow-sm">
							{getConnectionStateLabel(connectionState)}
						</div>
					</div>

					{errorMessage ? (
						<div className="rounded-2xl border border-red-300/60 bg-red-50/90 px-4 py-3 text-red-800 text-sm shadow-sm dark:border-red-500/40 dark:bg-red-900/25 dark:text-red-100">
							{errorMessage}
						</div>
					) : null}

					{renderMode(mode)}
				</div>
			</div>

			<footer
				className="absolute inset-x-0 z-10 flex justify-center px-6"
				style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.5rem)' }}
			>
				<div className="flex items-center gap-2 rounded-full border border-white/25 bg-[var(--lilac-elevated)] p-1 shadow backdrop-blur">
					<button
						type="button"
						className="cursor-pointer rounded-full px-3 py-2 font-semibold text-[10px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.12em] transition hover:bg-white/50 hover:text-[var(--lilac-ink)]"
						onClick={clearCurrentModeHistory}
					>
						Clear
					</button>
					<button
						type="button"
						className="cursor-pointer rounded-full bg-[var(--lilac-ink)] px-4 py-2 font-semibold text-[10px] text-[var(--lilac-surface)] uppercase tracking-[0.12em] transition hover:shadow"
						onClick={reconnectCurrentMode}
					>
						Reconnect
					</button>
				</div>
			</footer>
		</div>
	)
}
