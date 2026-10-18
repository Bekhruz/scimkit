# Connecting Okta

This guide connects an Okta organization to a scimkit endpoint, so that Okta creates, updates and
deactivates users and pushes groups. Okta's admin console changes from time to time; the labels below are
the ones in use at the time of writing.

## Before you start

- Your SCIM endpoint is reachable over HTTPS, for example `https://app.example.com/scim/v2`.
- You have a token for the customer's tenant:

  ```sh
  npx scimkit token create --tenant acme --label "Okta" --database-url "$DATABASE_URL"
  ```

- The endpoint passes the Okta profile: `npx scimkit verify https://app.example.com/scim/v2 --token <token> --profile okta`.

## Configure the app integration

1. In the Okta Admin Console, open **Applications → Applications** and select your app integration (SAML or
   OIDC), or create one with **Create App Integration**.
2. On the **General** tab, under **App Settings**, choose **Edit**, set **Provisioning** to **SCIM** and save.
3. On the **Provisioning** tab, under **Integration**, choose **Edit** and enter:
   - **SCIM connector base URL**: `https://app.example.com/scim/v2`
   - **Unique identifier field for users**: `userName`
   - **Supported provisioning actions**: _Push New Users_, _Push Profile Updates_ and _Push Groups_
     (and _Import New Users and Profile Updates_ if you want Okta to read existing users)
   - **Authentication Mode**: _HTTP Header_, with the token as the bearer token
4. Choose **Test Connector Configuration**. Okta calls the endpoint with the token and reports which
   provisioning actions work. Save.
5. Under **Provisioning → To App**, choose **Edit** and enable _Create Users_, _Update User Attributes_ and
   _Deactivate Users_. Enable _Sync Password_ only if you configured the `setPassword` hook.
6. Assign people or groups on the **Assignments** tab, and push groups on the **Push Groups** tab.

## What Okta sends

| Event in Okta                       | Request                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| A user is assigned                  | `GET /Users?filter=userName eq "…"`, then `POST /Users` if not found              |
| A profile changes                   | `PUT /Users/{id}` with the whole user                                             |
| A user is unassigned or deactivated | `PATCH /Users/{id}` with `{"op":"replace","value":{"active":false}}`              |
| A group is pushed                   | `POST /Groups`, then `PATCH /Groups/{id}` adding and removing members             |
| A pushed group is renamed           | `PATCH /Groups/{id}` with `{"op":"replace","value":{"id":"…","displayName":"…"}}` |

Okta deactivates users rather than deleting them. React to the `user.deactivated` event (end sessions,
release the seat) and keep the account, so that a reactivation restores it.

```ts
hooks: {
  onEvent: async (event) => {
    if (event.type === 'user.deactivated') await sessions.revokeAll(event.id);
    if (event.type === 'user.reactivated') await audit.log('reactivated', event.id);
  },
},
```

## Troubleshooting

- **Okta reports a 401.** The token is wrong, expired or revoked. `npx scimkit token list --tenant acme`
  shows its state and when it was last used.
- **Users are created twice, or Okta reports a conflict.** Okta matches existing users by `userName`.
  Make sure the attribute you map to `userName` in Okta is unique, and that you did not create the users
  through another path with a different `userName`.
- **"Unknown attribute" in your logs.** Custom attributes mapped in Okta need a schema: add them with
  `customizeSchema(USER_SCHEMA, { add: [...] })` or a schema extension. In lenient mode they are ignored
  until then.
