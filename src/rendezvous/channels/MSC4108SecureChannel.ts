/*
Copyright 2024 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {
    CheckCode,
    Curve25519PublicKey,
    EstablishedSecureChannel,
    QrCodeData,
    QrCodeMode,
    SecureChannel,
} from "@matrix-org/matrix-sdk-crypto-wasm";

import {
    ClientRendezvousFailureReason,
    MSC4108FailureReason,
    MSC4108Payload,
    RendezvousError,
    RendezvousFailureListener,
} from "..";
import { MSC4108RendezvousSession } from "../transports/MSC4108RendezvousSession";
import { logger } from "../../logger";

/**
 * Imports @matrix-org/matrix-sdk-crypto-wasm so should be async-imported to avoid bundling the WASM into the main bundle.
 */
export class MSC4108SecureChannel {
    private readonly secureChannel: SecureChannel;
    private establishedChannel?: EstablishedSecureChannel;
    private connected = false;

    public constructor(
        private rendezvousSession: MSC4108RendezvousSession,
        private theirPublicKey?: Curve25519PublicKey,
        public onFailure?: RendezvousFailureListener,
    ) {
        this.secureChannel = new SecureChannel();
    }

    public async generateCode(mode: QrCodeMode, homeserverBaseUrl?: string): Promise<Uint8Array> {
        const { url } = this.rendezvousSession;

        if (!url) {
            throw new Error("No rendezvous session URL");
        }

        return new QrCodeData(
            this.secureChannel.public_key(),
            url,
            mode === QrCodeMode.Reciprocate ? homeserverBaseUrl : undefined,
        ).to_bytes();
    }

    public getCheckCode(): CheckCode | undefined {
        return this.establishedChannel?.check_code();
    }

    public async connect(): Promise<void> {
        if (this.connected) {
            throw new Error("Channel already connected");
        }

        if (this.theirPublicKey) {
            // We are the scanning device
            this.establishedChannel = this.secureChannel.create_outbound_channel(this.theirPublicKey);

            /**
             Secure Channel step 4. Device S sends the initial message

             Nonce := 0
             SH := ECDH(Ss, Gp)
             EncKey := HKDF_SHA256(SH, "MATRIX_QR_CODE_LOGIN|" || Gp || "|" || Sp, 0, 32)
             TaggedCiphertext := ChaCha20Poly1305_Encrypt(EncKey, Nonce, "MATRIX_QR_CODE_LOGIN_INITIATE")
             Nonce := Nonce + 2
             LoginInitiateMessage := UnpaddedBase64(TaggedCiphertext) || "|" || UnpaddedBase64(Sp)
             */
            {
                logger.info("Sending LoginInitiateMessage");
                const loginInitiateMessage = this.establishedChannel.encrypt("MATRIX_QR_CODE_LOGIN_INITIATE");
                await this.rendezvousSession.send(loginInitiateMessage);
            }

            /**
                Secure Channel step 6. Verification by Device S

                Nonce_G := 1
                (TaggedCiphertext, Sp) := Unpack(Message)
                Plaintext := ChaCha20Poly1305_Decrypt(EncKey, Nonce_G, TaggedCiphertext)
                Nonce_G := Nonce_G + 2

                unless Plaintext == "MATRIX_QR_CODE_LOGIN_OK":
                    FAIL

             */
            {
                logger.info("Waiting for LoginOkMessage");
                const ciphertext = await this.rendezvousSession.receive();

                if (!ciphertext) {
                    throw new RendezvousError(
                        "No response from other device",
                        MSC4108FailureReason.UnexpectedMessageReceived,
                    );
                }
                const candidateLoginOkMessage = await this.decrypt(ciphertext);

                if (candidateLoginOkMessage !== "MATRIX_QR_CODE_LOGIN_OK") {
                    throw new RendezvousError(
                        "Invalid response from other device",
                        ClientRendezvousFailureReason.InsecureChannelDetected,
                    );
                }

                // Step 6 is now complete. We trust the channel
            }
        } else {
            /**
                Secure Channel step 5. Device G confirms

                Nonce_S := 0
                (TaggedCiphertext, Sp) := Unpack(LoginInitiateMessage)
                SH := ECDH(Gs, Sp)
                EncKey := HKDF_SHA256(SH, "MATRIX_QR_CODE_LOGIN|" || Gp || "|" || Sp, 0, 32)
                Plaintext := ChaCha20Poly1305_Decrypt(EncKey, Nonce_S, TaggedCiphertext)
                Nonce_S := Nonce_S + 2

             */
            // wait for the other side to send us their public key
            logger.info("Waiting for LoginInitiateMessage");
            const loginInitiateMessage = await this.rendezvousSession.receive();
            if (!loginInitiateMessage) {
                throw new Error("No response from other device");
            }

            const { channel, message: candidateLoginInitiateMessage } =
                this.secureChannel.create_inbound_channel(loginInitiateMessage);
            this.establishedChannel = channel;

            if (candidateLoginInitiateMessage !== "MATRIX_QR_CODE_LOGIN_INITIATE") {
                throw new RendezvousError(
                    "Invalid response from other device",
                    ClientRendezvousFailureReason.InsecureChannelDetected,
                );
            }
            logger.info("LoginInitiateMessage received");

            logger.info("Sending LoginOkMessage");
            const loginOkMessage = await this.encrypt("MATRIX_QR_CODE_LOGIN_OK");
            await this.rendezvousSession.send(loginOkMessage);

            // Step 5 is complete. We don't yet trust the channel

            // next step will be for the user to confirm the check code on the other device
        }

        this.connected = true;
    }

    private async decrypt(ciphertext: string): Promise<string> {
        if (!this.establishedChannel) {
            throw new Error("Channel closed");
        }

        return this.establishedChannel.decrypt(ciphertext);
    }

    private async encrypt(plaintext: string): Promise<string> {
        if (!this.establishedChannel) {
            throw new Error("Channel closed");
        }

        return this.establishedChannel.encrypt(plaintext);
    }

    public async secureSend<T extends MSC4108Payload>(payload: T): Promise<void> {
        if (!this.connected) {
            throw new Error("Channel closed");
        }

        const stringifiedPayload = JSON.stringify(payload);
        logger.info(`=> ${stringifiedPayload}`);

        await this.rendezvousSession.send(await this.encrypt(stringifiedPayload));
    }

    public async secureReceive<T extends MSC4108Payload>(): Promise<Partial<T> | undefined> {
        if (!this.establishedChannel) {
            throw new Error("Channel closed");
        }

        const ciphertext = await this.rendezvousSession.receive();
        if (!ciphertext) {
            return undefined;
        }
        const plaintext = await this.decrypt(ciphertext);
        const json = JSON.parse(plaintext);

        logger.info(`<= ${JSON.stringify(json)}`);
        return json as Partial<T> | undefined;
    }

    public async close(): Promise<void> {}

    public async cancel(reason: MSC4108FailureReason | ClientRendezvousFailureReason): Promise<void> {
        try {
            await this.rendezvousSession.cancel(reason);
            this.onFailure?.(reason);
        } finally {
            await this.close();
        }
    }
}
