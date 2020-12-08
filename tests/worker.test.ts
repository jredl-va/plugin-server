import { makePiscina } from '../src/worker/piscina'
import { defaultConfig } from '../src/config'
import { PluginEvent } from 'posthog-plugins/src/types'
import { performance } from 'perf_hooks'
import { mockJestWithIndex } from './helpers/plugins'
import * as os from 'os'
import { LogLevel } from '../src/types'

jest.mock('../src/sql')
jest.setTimeout(300000) // 300 sec timeout

function processOneEvent(
    processEvent: (event: PluginEvent) => Promise<PluginEvent>,
    index: number
): Promise<PluginEvent> {
    const defaultEvent = {
        distinct_id: 'my_id',
        ip: '127.0.0.1',
        site_url: 'http://localhost',
        team_id: 2,
        now: new Date().toISOString(),
        event: 'default event',
        properties: { key: 'value', index },
    }

    return processEvent(defaultEvent)
}

function processOneBatch(
    processEvents: (events: PluginEvent[]) => Promise<PluginEvent[]>,
    batchSize: number,
    batchIndex: number
): Promise<PluginEvent[]> {
    const events = [...Array(batchSize)].map((_, i) => ({
        distinct_id: 'my_id',
        ip: '127.0.0.1',
        site_url: 'http://localhost',
        team_id: 2,
        now: new Date().toISOString(),
        event: 'default event',
        properties: { key: 'value', batchIndex, indexInBatch: i },
    }))

    return processEvents(events)
}

async function processCountEvents(piscina: ReturnType<typeof makePiscina>, count: number, batchSize = 1) {
    const maxPromises = 1000
    const startTime = performance.now()
    const promises = Array(maxPromises)
    const processEvent = (event: PluginEvent) => piscina.runTask({ task: 'processEvent', args: { event } })
    const processEvents = (events: PluginEvent[]) => piscina.runTask({ task: 'processEvents', args: { events } })

    const groups = Math.ceil(count / maxPromises)
    for (let j = 0; j < groups; j++) {
        const groupCount = groups === 1 ? count : j === groups - 1 ? count % maxPromises : maxPromises
        for (let i = 0; i < groupCount; i++) {
            promises[i] =
                batchSize === 1 ? processOneEvent(processEvent, i) : processOneBatch(processEvents, batchSize, i)
        }
        await Promise.all(promises)
    }

    const ms = Math.round((performance.now() - startTime) * 1000) / 1000

    const log = {
        eventsPerSecond: 1000 / (ms / count),
        events: count,
        concurrency: piscina.threads.length,
        totalMs: ms,
        averageEventMs: ms / count,
    }

    return log
}

function setupPiscina(workers: number, code: string, tasksPerWorker: number) {
    return makePiscina({
        ...defaultConfig,
        WORKER_CONCURRENCY: workers,
        TASKS_PER_WORKER: tasksPerWorker,
        LOG_LEVEL: LogLevel.Log,
        __jestMock: mockJestWithIndex(code),
    })
}

test('piscina worker test', async () => {
    // Uncomment this to become a 10x developer and make the test run just as fast!
    const isDevRun = true

    const coreCount = os.cpus().length
    const workerThreads = [1, 2, 4, 8, 12, 16].filter((threads) =>
        isDevRun ? threads < coreCount : threads <= coreCount
    )
    const rounds = 5

    const tests: { testName: string; events: number; testCode: string }[] = [
        {
            testName: 'simple',
            events: 10000,
            testCode: `
                function processEvent (event, meta) {
                    event.properties = { "somewhere": "over the rainbow" };
                    return event
                }
            `,
        },
        {
            testName: 'for200k',
            events: 10000,
            testCode: `
                function processEvent (event, meta) {
                    let j = 0; for(let i = 0; i < 200000; i++) { j = i };
                    event.properties = { "somewhere": "over the rainbow" };
                    return event
                }
            `,
        },
        {
            testName: 'timeout100ms',
            events: 2000,
            testCode: `
                async function processEvent (event, meta) {
                    await new Promise(resolve => __jestSetTimeout(() => resolve(), 100))
                    event.properties = { "somewhere": "over the rainbow" };
                    return event             
                }
            `,
        },
    ]

    const results: Array<Record<string, string | number>> = []
    for (const { testName, events, testCode } of tests) {
        const result: Record<string, any> = {
            testName,
            coreCount,
        }
        for (const threads of workerThreads) {
            const piscina = setupPiscina(threads, testCode, 100)

            // warmup
            await processCountEvents(piscina, threads * 4)

            // start
            let throughput = 0
            for (let i = 0; i < rounds; i++) {
                const { eventsPerSecond } = await processCountEvents(piscina, isDevRun ? events / 10 : events)
                throughput += eventsPerSecond
            }
            result[`${threads} threads`] = Math.round(throughput / rounds)
            await piscina.destroy()
        }
        results.push(result)
        console.log(JSON.stringify({ result }, null, 2))
    }
    console.table(results)
})