import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type RuntimeLogCapture = {
	stderrPath: string
	stdoutPath: string
	stop: () => Promise<void>
}

export type StartRuntimeLogCaptureInput = {
	artifactDirectoryPath: string
	deploymentDomain: string
	vercelToken?: string
}

export async function startVercelRuntimeLogCapture(
	input: StartRuntimeLogCaptureInput
): Promise<RuntimeLogCapture> {
	const runtimeDirectoryPath = join(input.artifactDirectoryPath, 'runtime-logs')
	await mkdir(runtimeDirectoryPath, { recursive: true })

	const stdoutPath = join(runtimeDirectoryPath, 'vercel-runtime.jsonl')
	const stderrPath = join(runtimeDirectoryPath, 'vercel-runtime.stderr.log')
	const stdoutWriter = createWriteStream(stdoutPath, { flags: 'w' })
	const stderrWriter = createWriteStream(stderrPath, { flags: 'w' })

	const captureEnvironment = {
		...process.env
	}
	if (input.vercelToken) captureEnvironment.VERCEL_TOKEN = input.vercelToken

	const vercelProcess = spawn('vercel', ['logs', input.deploymentDomain, '--json'], {
		env: captureEnvironment,
		stdio: ['ignore', 'pipe', 'pipe']
	})

	vercelProcess.stdout.pipe(stdoutWriter)
	vercelProcess.stderr.pipe(stderrWriter)

	async function stop(): Promise<void> {
		if (!vercelProcess.killed) {
			vercelProcess.kill('SIGINT')
		}
		await new Promise<void>(resolve => {
			vercelProcess.once('close', () => resolve())
			setTimeout(() => resolve(), 3000)
		})
		stdoutWriter.end()
		stderrWriter.end()
	}

	return {
		stderrPath,
		stdoutPath,
		stop
	}
}

export async function collectRuntimeErrorMatches(runtimeLogPath: string): Promise<string[]> {
	const runtimeLogContent = await readFile(runtimeLogPath, 'utf8')
	const runtimeLogLines = runtimeLogContent
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean)

	const matchPatterns = [
		/Unsupported parameter/i,
		/Unknown parameter/i,
		/Unhandled/i,
		/An error occurred in the Server Components render/i,
		/\bdigest\b/i
	]

	const matches: string[] = []
	for (const runtimeLine of runtimeLogLines) {
		if (matchPatterns.some(pattern => pattern.test(runtimeLine))) {
			matches.push(runtimeLine)
		}
	}
	return matches
}
