# Connecting Microsoft Entra ID

This guide connects a Microsoft Entra ID tenant to a scimkit endpoint through an enterprise application.
The Entra admin center changes from time to time; the labels below are the ones in use at the time of
writing.

## Before you start

- Your SCIM endpoint is reachable over HTTPS, for example `https://app.example.com/scim/v2`. Entra's
  provisioning service calls it from Microsoft's network, so it must be reachable from the internet.
- You have a token for the customer's tenant:

  ```sh
  npx scimkit token create --tenant contoso --label "Entra ID" --database-url "$DATABASE_URL"
  ```

- The endpoint passes the Entra profile: `npx scimkit verify https://app.example.com/scim/v2 --token <token> --profile entra`.

## Configure provisioning

1. In the Microsoft Entra admin center, open **Enterprise applications** and choose **New application →
   Create your own application**, _Integrate any other application you don't find in the gallery_. (Or
   open the enterprise application you already use for single sign-on.)
2. Open **Provisioning**, set **Provisioning Mode** to **Automatic**, and under **Admin Credentials** enter:
   - **Tenant URL**: `https://app.example.com/scim/v2`
   - **Secret Token**: the token
3. Choose **Test Connection**, then save.
4. Review **Mappings**. By default Entra maps `userPrincipalName` to `userName` and matches users on it.
   Map `mail` instead if your application signs people in with their email address.
5. Under **Settings**, choose the scope (usually _Sync only assigned users and groups_), assign users and
   groups under **Users and groups**, and turn **Provisioning Status** on.

Entra provisions in cycles (the first one can take a while, later ones run about every 40 minutes). Use
**Provision on demand** to send one user right away while you test.

## What Entra sends

| Event in Entra                                   | Request                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| A user comes into scope                          | `GET /Users?filter=userName eq "…"`, then `POST /Users` with the enterprise extension             |
| An attribute changes                             | `PATCH /Users/{id}` with paths such as `emails[type eq "work"].value` and `name.familyName`       |
| A manager is set or cleared                      | `PATCH` with `{"op":"Add","path":"urn:…:enterprise:2.0:User:manager","value":"<id>"}` or `Remove` |
| A user is disabled, soft-deleted or leaves scope | `PATCH` with `{"op":"Replace","path":"active","value":"False"}`                                   |
| A user is deleted permanently                    | `DELETE /Users/{id}`                                                                              |
| A group comes into scope                         | `POST /Groups`, then `PATCH /Groups/{id}` with `{"op":"Add","path":"members","value":[…]}`        |
| Membership is checked                            | `GET /Groups?filter=id eq "…" and members[value eq "…"]&excludedAttributes=members`               |
| A member is removed                              | `PATCH` with `{"op":"Remove","path":"members","value":[{"value":"…"}]}`                           |

Several of these depart from RFC 7644: capitalised operation names, the string `"False"`, a bare id as the
manager value, a schema URI that is not a SCIM schema in `schemas` when creating groups, value filters that
create values which do not exist yet, and member removal by value list. scimkit's lenient mode (the default)
accepts all of them. Microsoft documents a feature flag for its newer, more standard PATCH behaviour (added
to the Tenant URL as a query parameter); you do not need it with scimkit, which accepts both behaviours.

## Troubleshooting

- **Test Connection fails.** Check that the URL is the SCIM root (it ends in `/scim/v2`, without
  `/Users`), that the token is valid (`npx scimkit token list --tenant contoso`), and that your firewall
  allows Microsoft's provisioning service.
- **Entra reports "the attribute is not supported".** Attributes you add in the mappings must exist in a
  schema of the resource type. Add them with `customizeSchema` or an extension and restart; in lenient mode
  unknown attributes are ignored until then.
- **Duplicate users.** Entra matches on the matching attribute of the mapping (by default `userName`). Keep
  it the same value your application stores in `userName`.
- The provisioning logs in Entra show the exact request and response for each operation. scimkit's
  `X-Request-Id` response header matches the request id in your logs.
