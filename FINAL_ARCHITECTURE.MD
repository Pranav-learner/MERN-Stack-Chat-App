                   Authentication Service
                           │
                  JWT / Device Identity
                           │
          ┌────────────────┴────────────────┐
          │                                 │
     Metadata Service                Signaling Service
          │                                 │
          └──────────────┬──────────────────┘
                         │
                    ICE/STUN/TURN
                         │
                Secure Handshake (SHS)
                         │
               ECDH Key Agreement
                         │
              Session Key Derivation
                         │
            End-to-End Encryption Layer
                         │
          ┌──────────────┴──────────────┐
          │                             │
     Direct P2P Channel           Relay Fallback
          │                             │
          └──────────────┬──────────────┘
                         │
                Encrypted Message Sync
                         │
          Multi-device Recovery / Offline Queue