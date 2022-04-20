import chalk from "chalk";
import { format } from "date-fns";
import fs from "fs";
import path from "path";
import { BaseConfigDataFolder } from "./BaseConfig";
import { ClientBroker } from "./ClientBroker";
import { Config } from "./Config";

export enum LOGLEVEL {
    ERROR = "ERROR",
    WARNING = "WARNING",
    INFO = "INFO",
    DEBUG = "DEBUG",
    FATAL = "FATAL",
    SUCCESS = "SUCCESS",
}

export interface LogLine {
    module: string;
    time: number;
    level: LOGLEVEL;
    text: string;
    pid?: number;
    metadata?: any;
}

export class Log {

    public static currentDate = "";
    public static lines: LogLine[] = [];

    public static websocket_buffer: LogLine[] = [];
    public static websocket_timer: NodeJS.Timeout | undefined;

    static readonly LOG_COLORS = {
        [LOGLEVEL.ERROR]: chalk.red,
        [LOGLEVEL.WARNING]: chalk.yellow,
        [LOGLEVEL.INFO]: chalk.blue,
        [LOGLEVEL.DEBUG]: chalk.gray,
        [LOGLEVEL.FATAL]: chalk.red,
        [LOGLEVEL.SUCCESS]: chalk.green,
    };

    static readTodaysLog() {
        console.log(chalk.blue("Read today's log..."));
        const today = format(new Date(), "yyyy-MM-dd");
        const filename = `${today}.log`;
        const filepath = path.join(BaseConfigDataFolder.logs, filename);
        const jsonlinename = `${filepath}.jsonline`;

        if (!fs.existsSync(filepath)) {
            return;
        }

        const lines = fs.readFileSync(jsonlinename, "utf8").split("\n");
        // console.log(`Read ${lines.length} lines from ${jsonlinename}`);
        this.lines = lines.map(line => line.length > 0 ? JSON.parse(line) : null).filter(line => line !== null);
        console.log(chalk.green(`✔ Parsed ${this.lines.length} lines from ${jsonlinename}`));
        this.currentDate = today;
    }

    /**
     * Log a message to the log file. Do NOT call before loading the config.
     * 
     * @param level 
     * @param module 
     * @param text 
     * @param metadata 
     * @returns 
     */
    static logAdvanced(level: LOGLEVEL, module: string, text: string, metadata?: any) {
        if (!Config.debug && level == LOGLEVEL.DEBUG) return;

        // if testing, don't log
        if (process.env.NODE_ENV == "test") return;

        // check if folder exists
        if (!fs.existsSync(BaseConfigDataFolder.logs)) {
            throw new Error("Log folder does not exist!");
        }

        if (!Log.currentDate) {
            console.error(chalk.bgRed.whiteBright("😤 Log called before date was set!"));
        }

        // clear old logs from memory
        const today = format(new Date(), "yyyy-MM-dd");
        if (today != Log.currentDate) {
            console.log(chalk.yellow(`Clearing log memory from ${Log.currentDate} to ${today}`));
            Log.currentDate = today;
            Log.lines = [];
        }

        // today's filename in Y-m-d format
        const date = new Date();
        const filename = format(date, "yyyy-MM-dd") + ".log";
        const filepath = path.join(BaseConfigDataFolder.logs, filename);
        const jsonlinename = `${filepath}.jsonline`;

        const dateFormat = "yyyy-MM-dd HH:mm:ss.SSS";
        const dateString = format(date, dateFormat);

        // write cleartext
        const textOutput = `${dateString} ${process.pid} | ${module} <${level}> ${text}`;
        fs.appendFileSync(filepath, textOutput + "\n");

        // if docker, output to stdout
        // if (TwitchConfig.cfg("docker")) {
        //     console.log(textOutput);
        // }

        console.log(
            this.LOG_COLORS[level](`${dateString} | ${module} <${level}> ${text}`)
        );

        const log_data: LogLine = {
            module: module,
            time: Date.now(),
            level: level,
            text: text,
            pid: process.pid,
        };

        if (metadata !== undefined) log_data.metadata = metadata;

        let stringy_log_data;
        try {
            stringy_log_data = JSON.stringify(log_data);
        } catch (e) {
            console.error(chalk.bgRed.whiteBright("😤 Error stringifying log data!"), log_data);
            return;
        }

        // write jsonline
        fs.appendFileSync(jsonlinename, stringy_log_data + "\n");
        this.lines.push(log_data);

        // send over websocket, probably extremely slow
        if (Config.cfg<boolean>("websocket_log")) {

            this.websocket_buffer.push(log_data);

            if (Log.websocket_timer) clearTimeout(Log.websocket_timer);
            Log.websocket_timer = setTimeout(() => {
                // console.debug(`Sending ${this.websocket_buffer.length} lines over websocket`);
                ClientBroker.broadcast({
                    action: "log",
                    data: this.websocket_buffer,
                });
                this.websocket_buffer = [];
                Log.websocket_timer = undefined;
            }, 5000);
            
        }

        /*
        ClientBroker.broadcast({
            action: "log",
            data: log_data,
        });

        TwitchLog.websocket_timer = setTimeout(() => {
                    ClientBroker.send("log", TwitchLog.websocket_buffer);
                    TwitchLog.websocket_buffer = [];
                    TwitchLog.websocket_timer = undefined;
                }, 100);
            } else {
        */

    }

    /**
     * Fetch n lines from a log file.
     * @param date 
     * @param fromLine 
     * @throws
     * @returns 
     */
    static fetchLog(date: string, fromLine = 0): LogLine[] {

        // return lines from n to end
        if (date == this.currentDate) {
            // console.debug(`Fetching ${this.lines.length} lines starting from ${fromLine} from memory`);
            return this.lines.slice(fromLine);
        }

        const filename = `${date}.log`;
        const filepath = path.join(BaseConfigDataFolder.logs, filename);
        const jsonlinename = `${filepath}.jsonline`;

        if (!fs.existsSync(filepath)) {
            throw new Error(`File not found: ${filepath}`);
        }

        const lines = fs.readFileSync(jsonlinename, "utf8").split("\n");
        const parsed_lines: LogLine[] = lines.map(line => line.length > 0 ? JSON.parse(line) : null).filter(line => line !== null);
        // console.debug(`Fetched ${parsed_lines.length} lines from ${jsonlinename}`);
        return parsed_lines;
    }

}