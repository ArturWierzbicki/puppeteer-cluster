import Job from "./Job";
import Cluster, { TaskFunction } from "./Cluster";
import { Page } from "puppeteer";
import { timeoutExecute, debugGenerator, log } from "./util";
import { inspect } from "util";
import {
    WorkerInstance,
    JobInstance,
} from "./concurrency/ConcurrencyImplementation";

const debug = debugGenerator("Worker");

const DEFAULT_OPTIONS = {
    args: [],
};

interface WorkerOptions<JobData> {
    cluster: Cluster;
    args: string[];
    id: number;
    browser: WorkerInstance<JobData>;
}

const BROWSER_INSTANCE_TRIES = 10;

export interface WorkError {
    type: "error";
    error: Error;
}

export interface WorkData {
    type: "success";
    data: any;
}

export type WorkResult = WorkError | WorkData;

export default class Worker<JobData, ReturnData>
    implements WorkerOptions<JobData>
{
    cluster: Cluster;
    args: string[];
    id: number;
    browser: WorkerInstance<JobData>;

    activeJobs: Job<JobData, ReturnData>[] = [];

    public constructor({ cluster, args, id, browser }: WorkerOptions<JobData>) {
        this.cluster = cluster;
        this.args = args;
        this.id = id;
        this.browser = browser;
    }

    public async canHandle(job: Job<JobData, ReturnData>): Promise<boolean> {
        return (
            this.browser.canHandle?.(job.data) || this.activeJobs.length === 0
        );
    }

    public async handle(
        task: TaskFunction<JobData, ReturnData>,
        job: Job<JobData, ReturnData>,
        timeout: number
    ): Promise<WorkResult> {
        this.activeJobs.push(job);

        let jobInstance: JobInstance | null = null;
        let page: Page | null = null;

        let tries = 0;

        while (jobInstance === null) {
            try {
                jobInstance = await this.browser.jobInstance(job.data);
                page = jobInstance.resources.page;
            } catch (err: any) {
                debug(
                    `Error getting browser page (try: ${tries}), message: ${err.message}`
                );
                await this.browser.repair();
                tries += 1;
                if (tries >= BROWSER_INSTANCE_TRIES) {
                    throw new Error("Unable to get browser page");
                }
            }
        }

        // We can be sure that page is set now, otherwise an exception would've been thrown
        page = page as Page; // this is just for TypeScript

        let errorState: Error | null = null;

        page.on("error", (err) => {
            errorState = err;
            log(
                `Error (page error) crawling ${inspect(job.data)} // message: ${
                    err.message
                }`
            );
        });

        let result: any;
        try {
            result = await timeoutExecute(
                timeout,
                task({
                    page,
                    // data might be undefined if queue is only called with a function
                    // we ignore that case, as the user should use Cluster<undefined> in that case
                    // to get correct typings
                    data: job.data as JobData,
                    worker: {
                        id: this.id,
                    },
                })
            );
        } catch (err: any) {
            errorState = err;
            log(
                `Error crawling ${inspect(job.data)} // message: ${err.message}`
            );
        }

        debug(`Finished executing task on worker #${this.id}`);

        try {
            await jobInstance.close();
        } catch (e: any) {
            debug(
                `Error closing browser instance for ${inspect(job.data)}: ${
                    e.message
                }`
            );
            await this.browser.repair();
        }

        this.activeJobs.splice(this.activeJobs.indexOf(job), 1);

        if (errorState) {
            return {
                type: "error",
                error: errorState || new Error("asf"),
            };
        }
        return {
            data: result,
            type: "success",
        };
    }

    public async close(): Promise<void> {
        try {
            await this.browser.close();
        } catch (err: any) {
            debug(
                `Unable to close worker browser. Error message: ${err.message}`
            );
        }
        debug(`Closed #${this.id}`);
    }

    public isIdle(): boolean {
        return this.activeJobs.length === 0;
    }
}
