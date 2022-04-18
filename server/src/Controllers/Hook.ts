import { TwitchChannel } from "../Core/TwitchChannel";
import { TwitchConfig } from "../Core/TwitchConfig";
import express from "express";
import crypto from "crypto";
import path from "path";
import { AppRoot } from "../Core/BaseConfig";
import fs from "fs";
import { TwitchAutomator } from "../Core/TwitchAutomator";
import { EventSubResponse } from "../../../common/TwitchAPI/EventSub";
import { ChallengeResponse } from "../../../common/TwitchAPI/Challenge";
import { LOGLEVEL, TwitchLog } from "../Core/TwitchLog";
import { KeyValue } from "../Core/KeyValue";
import { SubStatus } from "../../../common/Defs";
import { replaceAll } from "Helpers/ReplaceAll";

const verifySignature = (request: express.Request): boolean => {

    // calculate signature
    /*
            hmac_message = headers['Twitch-Eventsub-Message-Id'] + headers['Twitch-Eventsub-Message-Timestamp'] + request.body
            signature = hmac_sha256(webhook_secret, hmac_message)
            expected_signature_header = 'sha256=' + signature.hex()

            if headers['Twitch-Eventsub-Message-Signature'] != expected_signature_header:
                return 403
        */

    if (!TwitchConfig.cfg("eventsub_secret")) {
        TwitchLog.logAdvanced(LOGLEVEL.ERROR, "hook", "No eventsub secret in config.");
        return false;
    }

    const twitch_message_id = request.header("Twitch-Eventsub-Message-Id");
    const twitch_message_timestamp = request.header("Twitch-Eventsub-Message-Timestamp");
    const twitch_message_signature = request.header("Twitch-Eventsub-Message-Signature");

    /*
        $hmac_message =
            $twitch_message_id .
            $twitch_message_timestamp .
            $request->getBody()->getContents();

        $signature = hash_hmac("sha256", $hmac_message, TwitchConfig::cfg("eventsub_secret"));

        $expected_signature_header = "sha256=${signature}";

        // check signature
        return $twitch_message_signature === $expected_signature_header;
        */

    if (!twitch_message_id || !twitch_message_timestamp || !twitch_message_signature) {
        TwitchLog.logAdvanced(LOGLEVEL.ERROR, "hook", "Missing twitch headers for signature check.");
        return false;
    }
    
    // const body = JSON.stringify(request.body); // needs raw body
    const body: string = (request as any).rawBody;

    const hmac_message = twitch_message_id + twitch_message_timestamp + body;

    const signature = crypto.createHmac("sha256", TwitchConfig.cfg("eventsub_secret"))
        .update(hmac_message)
        .digest("hex");

    const expected_signature_header = "sha256=" + signature;

    if (twitch_message_signature !== expected_signature_header) {
        console.log(`Signature mismatch: ${twitch_message_signature} != ${expected_signature_header}`);
    }

    return twitch_message_signature === expected_signature_header;

};

export function Hook(req: express.Request, res: express.Response): void {

    const source = req.query.source ?? "twitch";

    // console.log("Body", req.body, req.body.toString(), JSON.stringify(req.body));

    const data_json: EventSubResponse | ChallengeResponse = req.body;

    const debugMeta = { "GET": req.query, "POST": req.body, "HEADERS": req.headers, "DATA": data_json };

    TwitchLog.logAdvanced(LOGLEVEL.INFO, "hook", "Hook called", debugMeta);

    if (TwitchConfig.cfg("instance_id")) {
        if (!req.query.instance || req.query.instance != TwitchConfig.cfg("instance_id")) {
            TwitchLog.logAdvanced(LOGLEVEL.ERROR, "hook", `Hook called with the wrong instance (${req.query.instance})`);
            res.send("Invalid instance");
            return;
        }
    }

    // handle regular hook
    if (source == "twitch") {

        // if (post_json) {
        //     TwitchLog.logAdvanced(LOGLEVEL.DEBUG, "hook", "Custom payload received...");
        //     $data_json = json_decode($post_json, true);
        // }

        if (data_json && Object.keys(data_json).length > 0) {

            if (req.header("Twitch-Notification-Id")) {

                TwitchLog.logAdvanced(
                    LOGLEVEL.ERROR,
                    "hook",
                    "Hook got data with old webhook format."
                );
                res.status(400).send("Outdated format");
            }

            const message_retry = req.header("Twitch-Eventsub-Message-Retry") || null;

            // console.log("Message retry", message_retry);

            if ("challenge" in data_json && data_json.challenge !== null) {

                const challenge = data_json.challenge;
                const subscription = data_json.subscription;

                const sub_type = subscription.type;

                const channel_id = subscription["condition"]["broadcaster_user_id"];
                const channel_login = TwitchChannel.channelLoginFromId(subscription.condition.broadcaster_user_id);

                // $username = TwitchHelper::getChannelUsername($subscription["condition"]["broadcaster_user_id"]);

                // $signature = $response->getHeader("Twitch-Eventsub-Message-Signature");

                TwitchLog.logAdvanced(LOGLEVEL.INFO, "hook", `Challenge received for ${channel_id}:${sub_type} (${channel_login}) (${subscription["id"]}), retry ${message_retry}`, debugMeta);

                if (!verifySignature(req)) {

                    TwitchLog.logAdvanced(
                        LOGLEVEL.FATAL,
                        "hook",
                        "Invalid signature check for challenge!"
                    );
                    KeyValue.set(`${channel_id}.substatus.${sub_type}`, SubStatus.FAILED);
                    res.status(400).send("Invalid signature check for challenge");
                }

                TwitchLog.logAdvanced(LOGLEVEL.SUCCESS, "hook", `Challenge completed, subscription active for ${channel_id}:${sub_type} (${channel_login}) (${subscription["id"]}), retry ${message_retry}.`, debugMeta);

                KeyValue.set(`${channel_id}.substatus.${sub_type}`, SubStatus.SUBSCRIBED);

                // return the challenge string to twitch if signature matches
                res.status(202).send(challenge);
                return;
            }

            if (TwitchConfig.debug || TwitchConfig.cfg<boolean>("dump_payloads")) {
                let payload_filename = replaceAll(new Date().toISOString(), /[-:.]/g, "_"); // @todo: replaceAll
                if (data_json.subscription.type) payload_filename += `_${data_json.subscription.type}`;
                payload_filename += ".json";
                const payload_filepath = path.join(AppRoot, "payloads", payload_filename);
                TwitchLog.logAdvanced(LOGLEVEL.INFO, "hook", `Dumping debug hook payload to ${payload_filepath}`);
                fs.writeFileSync(payload_filepath, JSON.stringify({
                    headers: req.headers,
                    body: data_json,
                    query: req.query,
                    ip: req.ip,
                }, null, 4));
            }

            // verify message
            if (!verifySignature(req)) {
                TwitchLog.logAdvanced(
                    LOGLEVEL.FATAL,
                    "hook",
                    "Invalid signature check for message!",
                    debugMeta
                );
                res.status(400).send("Invalid signature check");
                return;
            }

            if ("event" in data_json) {
                TwitchLog.logAdvanced(LOGLEVEL.DEBUG, "hook", `Signature checked, no challenge, retry ${message_retry}. Run handle...`);
                const TA = new TwitchAutomator();
                /* await */ TA.handle(data_json, req);
                res.status(200).send("");
                return;
            } else {
                TwitchLog.logAdvanced(LOGLEVEL.ERROR, "hook", "No event in message!");
                res.status(400).send("No event in message");
                return;
            }
        } else {
            TwitchLog.logAdvanced(LOGLEVEL.ERROR, "hook", "Hook called with invalid JSON.");
            res.status(400).send("No data supplied");
            return;
        }
    }

    TwitchLog.logAdvanced(LOGLEVEL.WARNING, "hook", `Hook called with no data (${source})...`, debugMeta);

    res.status(400).send("No data supplied");
    return;

}