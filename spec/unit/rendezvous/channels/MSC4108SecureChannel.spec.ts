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

import { QrCodeData, QrCodeMode, SecureChannel } from "@matrix-org/matrix-sdk-crypto-wasm";
import { mocked } from "jest-mock";

import { MSC4108RendezvousSession, MSC4108SecureChannel } from "../../../../src/rendezvous";

describe("MSC4108SecureChannel", () => {
    const url = "https://fallbackserver/rz/123";

    it("should generate qr code data as expected", async () => {
        const session = new MSC4108RendezvousSession({
            url,
        });
        const channel = new MSC4108SecureChannel(session);

        const code = await channel.generateCode(QrCodeMode.Login);
        expect(code).toHaveLength(71);
        const text = new TextDecoder().decode(code);
        expect(text.startsWith("MATRIX")).toBeTruthy();
        expect(text.endsWith(url)).toBeTruthy();
    });

    it("should be able to connect as a reciprocating device", async () => {
        const mockSession = {
            send: jest.fn(),
            receive: jest.fn(),
            url,
        } as unknown as MSC4108RendezvousSession;
        const channel = new MSC4108SecureChannel(mockSession);

        const qrCodeData = QrCodeData.from_bytes(await channel.generateCode(QrCodeMode.Reciprocate));
        const opponentChannel = new SecureChannel().create_outbound_channel(qrCodeData.public_key);
        const ciphertext = opponentChannel.encrypt("MATRIX_QR_CODE_LOGIN_INITIATE");

        mocked(mockSession.receive).mockResolvedValue(ciphertext);
        await channel.connect();
        expect(mockSession.send).toHaveBeenCalled();
        expect(opponentChannel.decrypt(mocked(mockSession.send).mock.calls[0][0])).toBe("MATRIX_QR_CODE_LOGIN_OK");
    });
});
