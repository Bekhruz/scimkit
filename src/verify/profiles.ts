import { randomUUID } from 'node:crypto';
import {
  bodyOf,
  expectEqual,
  expectStatus,
  expectTrue,
  type Json,
  listOf,
  stringField,
  valuesOf,
} from './assert.js';
import type { CheckResponse } from './client.js';
import { CheckSkipped, type Profile, type StepContext } from './runner.js';

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const SERVICE_PROVIDER_CONFIG = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';

const patch = (...operations: Json[]) => ({ schemas: [PATCH], Operations: operations });
const filter = (endpoint: string, expression: string, extra = '') =>
  `${endpoint}?filter=${encodeURIComponent(expression)}${extra}`;
const quoted = (value: string) => JSON.stringify(value);

async function create(context: StepContext, endpoint: string, key: string, body: Json): Promise<Json> {
  const response = await context.client.request('POST', endpoint, body);
  if (response.status === 201) {
    const id = bodyOf(response)['id'];
    if (typeof id === 'string') context.created(`${endpoint}/${encodeURIComponent(id)}`);
  }
  expectStatus(response, 201);
  const created = bodyOf(response);
  context.state.set(key, stringField(created, 'id'));
  return created;
}

/** The resource after a write: the response body, or a fresh read when the server answered 204. */
async function after(context: StepContext, path: string, response: CheckResponse): Promise<Json> {
  expectStatus(response, 200, 204);
  if (response.status === 200 && response.body !== undefined) return bodyOf(response);
  const read = await context.client.request('GET', path);
  expectStatus(read, 200);
  return bodyOf(read);
}

const userPath = (context: StepContext, key = 'user') =>
  `${context.endpoints.users}/${encodeURIComponent(context.state.get(key) as string)}`;
const groupPath = (context: StepContext, key = 'group') =>
  `${context.endpoints.groups}/${encodeURIComponent(context.state.get(key) as string)}`;

async function expectDeleted(context: StepContext, path: string): Promise<void> {
  const response = await context.client.request('DELETE', path);
  expectStatus(response, 204, 200);
  context.deleted(path);
  const read = await context.client.request('GET', path);
  expectStatus(read, 404);
}

async function findOne(context: StepContext, path: string, id: string): Promise<void> {
  const response = await context.client.request('GET', path);
  expectStatus(response, 200);
  const resources = listOf(response);
  expectEqual(bodyOf(response)['totalResults'], 1, 'totalResults');
  expectEqual(resources[0]?.['id'], id, 'id of the result');
}

async function findNone(context: StepContext, path: string): Promise<void> {
  const response = await context.client.request('GET', path);
  expectStatus(response, 200);
  listOf(response);
  expectEqual(bodyOf(response)['totalResults'], 0, 'totalResults');
}

// ------------------------------------------------------------------ RFC

/** The core protocol of RFC 7643 and RFC 7644, as any SCIM client relies on it. */
export const rfcProfile: Profile = {
  name: 'rfc',
  title: 'SCIM 2.0 core protocol (RFC 7643, RFC 7644)',
  steps: [
    {
      name: 'Advertises its features at /ServiceProviderConfig',
      async run(context) {
        const response = await context.client.request('GET', '/ServiceProviderConfig');
        expectStatus(response, 200);
        const body = bodyOf(response);
        expectTrue(
          Array.isArray(body['schemas']) && (body['schemas'] as unknown[]).includes(SERVICE_PROVIDER_CONFIG),
          'schemas does not include the ServiceProviderConfig URN',
        );
        expectEqual((body['patch'] as Json | undefined)?.['supported'], true, 'patch.supported');
        expectEqual((body['filter'] as Json | undefined)?.['supported'], true, 'filter.supported');
      },
    },
    {
      name: 'Responds with the application/scim+json media type',
      async run(context) {
        const response = await context.client.request('GET', '/ServiceProviderConfig');
        const type = response.headers.get('content-type') ?? '';
        expectTrue(
          type.startsWith('application/scim+json'),
          `Content-Type is "${type}"; SCIM responses use application/scim+json`,
        );
      },
    },
    {
      name: 'Lists resource types, including User',
      async run(context) {
        const response = await context.client.request('GET', '/ResourceTypes');
        expectStatus(response, 200);
        const types = listOf(response);
        expectTrue(
          types.some((type) => type['schema'] === USER),
          'no resource type uses the core User schema',
        );
      },
    },
    {
      name: 'Publishes the User schema',
      async run(context) {
        const response = await context.client.request('GET', '/Schemas');
        expectStatus(response, 200);
        expectTrue(
          listOf(response).some((schema) => schema['id'] === USER),
          `${USER} is not listed`,
        );
      },
    },
    {
      name: 'Creates a user (201, Location, meta)',
      async run(context) {
        const userName = `${context.name('ann')}@example.com`;
        context.state.set('userName', userName);
        const response = await context.client.request('POST', context.endpoints.users, {
          schemas: [USER],
          userName,
          externalId: context.name('ann'),
          name: { givenName: 'Ann', familyName: 'Lee' },
          emails: [{ value: userName, type: 'work', primary: true }],
          active: true,
        });
        if (response.status === 201 && typeof bodyOf(response)['id'] === 'string') {
          context.created(
            `${context.endpoints.users}/${encodeURIComponent(bodyOf(response)['id'] as string)}`,
          );
        }
        expectStatus(response, 201);
        const body = bodyOf(response);
        const id = stringField(body, 'id');
        context.state.set('user', id);
        expectEqual(String(body['userName']).toLowerCase(), userName.toLowerCase(), 'userName');
        expectTrue(
          Array.isArray(body['schemas']) && (body['schemas'] as unknown[]).includes(USER),
          'schemas does not include the User URN',
        );
        const meta = body['meta'] as Json | undefined;
        expectEqual(meta?.['resourceType'], 'User', 'meta.resourceType');
        const location = response.headers.get('location');
        expectTrue(location !== null && location !== '', 'the response has no Location header');
        expectTrue(
          meta?.['location'] === undefined || meta['location'] === location,
          'meta.location differs from the Location header',
        );
      },
    },
    {
      name: 'Reads the user',
      needs: ['user'],
      async run(context) {
        const response = await context.client.request('GET', userPath(context));
        expectStatus(response, 200);
        expectEqual(bodyOf(response)['id'], context.state.get('user'), 'id');
      },
    },
    {
      name: 'Rejects a duplicate userName with 409 uniqueness',
      needs: ['user', 'userName'],
      async run(context) {
        const response = await context.client.request('POST', context.endpoints.users, {
          schemas: [USER],
          userName: (context.state.get('userName') as string).toUpperCase(),
        });
        if (response.status === 201 && typeof bodyOf(response)['id'] === 'string') {
          context.created(
            `${context.endpoints.users}/${encodeURIComponent(bodyOf(response)['id'] as string)}`,
          );
        }
        expectStatus(response, 409);
        expectEqual(bodyOf(response)['scimType'], 'uniqueness', 'scimType');
      },
    },
    {
      name: 'Finds the user by userName, ignoring case',
      needs: ['user', 'userName'],
      async run(context) {
        const userName = (context.state.get('userName') as string).toUpperCase();
        await findOne(
          context,
          filter(context.endpoints.users, `userName eq ${quoted(userName)}`),
          context.state.get('user') as string,
        );
      },
    },
    {
      name: 'Finds nothing for an unknown userName',
      async run(context) {
        await findNone(
          context,
          filter(context.endpoints.users, `userName eq ${quoted(`${context.name('nobody')}@example.com`)}`),
        );
      },
    },
    {
      name: 'Paginates with startIndex and count',
      needs: ['user'],
      async run(context) {
        const response = await context.client.request(
          'GET',
          `${context.endpoints.users}?startIndex=1&count=1`,
        );
        expectStatus(response, 200);
        const resources = listOf(response);
        const body = bodyOf(response);
        expectTrue(resources.length <= 1, `count=1 returned ${resources.length} resources`);
        expectEqual(body['startIndex'], 1, 'startIndex');
        expectTrue(
          typeof body['totalResults'] === 'number' && body['totalResults'] >= 1,
          'totalResults is below 1',
        );
      },
    },
    {
      name: 'Returns only the attributes asked for',
      needs: ['user'],
      async run(context) {
        const response = await context.client.request('GET', `${userPath(context)}?attributes=userName`);
        expectStatus(response, 200);
        const body = bodyOf(response);
        expectTrue(typeof body['id'] === 'string', 'id is missing; it is always returned');
        expectTrue(typeof body['userName'] === 'string', 'userName is missing');
        expectTrue(
          body['name'] === undefined && body['emails'] === undefined,
          'attributes that were not asked for are returned',
        );
      },
    },
    {
      name: 'Leaves out excluded attributes',
      needs: ['user'],
      async run(context) {
        const response = await context.client.request(
          'GET',
          `${userPath(context)}?excludedAttributes=emails`,
        );
        expectStatus(response, 200);
        const body = bodyOf(response);
        expectTrue(body['emails'] === undefined, 'emails is returned although it was excluded');
        expectTrue(typeof body['userName'] === 'string', 'userName is missing');
      },
    },
    {
      name: 'Replaces the user with PUT',
      needs: ['user', 'userName'],
      async run(context) {
        const response = await context.client.request('PUT', userPath(context), {
          schemas: [USER],
          userName: context.state.get('userName'),
          name: { givenName: 'Ann', familyName: 'Lee' },
          nickName: 'Annie',
          active: true,
        });
        expectStatus(response, 200);
        expectEqual(bodyOf(response)['nickName'], 'Annie', 'nickName');
      },
    },
    {
      name: 'Updates the user with PATCH add, replace and remove',
      needs: ['user'],
      async run(context) {
        const path = userPath(context);
        const response = await context.client.request(
          'PATCH',
          path,
          patch(
            { op: 'replace', path: 'title', value: 'Engineer' },
            { op: 'add', path: 'displayName', value: 'Ann Lee' },
            { op: 'remove', path: 'nickName' },
          ),
        );
        const user = await after(context, path, response);
        expectEqual(user['title'], 'Engineer', 'title');
        expectEqual(user['displayName'], 'Ann Lee', 'displayName');
        expectEqual(user['nickName'], undefined, 'nickName');
      },
    },
    {
      name: 'Rejects an invalid filter with 400 invalidFilter',
      async run(context) {
        const response = await context.client.request(
          'GET',
          `${context.endpoints.users}?filter=${encodeURIComponent('userName eq')}`,
        );
        expectStatus(response, 400);
        expectEqual(bodyOf(response)['scimType'], 'invalidFilter', 'scimType');
      },
    },
    {
      name: 'Answers 404 for an unknown user',
      async run(context) {
        const response = await context.client.request('GET', `${context.endpoints.users}/${randomUUID()}`);
        expectStatus(response, 404);
      },
    },
    {
      name: 'Rejects a stale If-Match with 412',
      needs: ['user'],
      async run(context) {
        if (!context.features.etag) throw new CheckSkipped('the server does not advertise ETag support');
        const read = await context.client.request('GET', userPath(context));
        expectTrue(
          read.headers.get('etag') !== null,
          'the response has no ETag header although etag.supported is true',
        );
        const response = await context.client.request(
          'PATCH',
          userPath(context),
          patch({ op: 'replace', path: 'title', value: 'Stale' }),
          {
            'if-match': 'W/"scimkit-verify-stale"',
          },
        );
        expectStatus(response, 412);
      },
    },
    {
      name: 'Creates a group with a member',
      needs: ['user'],
      async run(context) {
        const group = await create(context, context.endpoints.groups, 'group', {
          schemas: [GROUP],
          displayName: context.name('engineering'),
          members: [{ value: context.state.get('user') }],
        });
        expectTrue(
          group['members'] === undefined ||
            valuesOf(group, 'members').includes(context.state.get('user') as string),
          'the new group does not list its member',
        );
      },
    },
    {
      name: 'Reads the members of the group',
      needs: ['group', 'user'],
      async run(context) {
        const response = await context.client.request('GET', groupPath(context));
        expectStatus(response, 200);
        expectEqual(valuesOf(bodyOf(response), 'members'), [context.state.get('user')], 'member ids');
      },
    },
    {
      name: 'Filters groups by member',
      needs: ['group', 'user'],
      async run(context) {
        await findOne(
          context,
          filter(
            context.endpoints.groups,
            `members[value eq ${quoted(context.state.get('user') as string)}] and displayName eq ${quoted(context.name('engineering'))}`,
          ),
          context.state.get('group') as string,
        );
      },
    },
    {
      name: 'Removes a member with PATCH',
      needs: ['group', 'user'],
      async run(context) {
        const path = groupPath(context);
        const response = await context.client.request(
          'PATCH',
          path,
          patch({ op: 'remove', path: `members[value eq ${quoted(context.state.get('user') as string)}]` }),
        );
        const group = await after(context, path, response);
        expectEqual(valuesOf(group, 'members'), [], 'member ids');
      },
    },
    {
      name: 'Deletes the group',
      needs: ['group'],
      async run(context) {
        await expectDeleted(context, groupPath(context));
      },
    },
    {
      name: 'Deletes the user',
      needs: ['user'],
      async run(context) {
        await expectDeleted(context, userPath(context));
      },
    },
  ],
};

// ------------------------------------------------------------------ Okta

/** The requests Okta's SCIM 2.0 provisioning sends, in the order it sends them. */
export const oktaProfile: Profile = {
  name: 'okta',
  title: 'Okta provisioning',
  steps: [
    {
      name: 'Looks the user up before creating it',
      async run(context) {
        const userName = `${context.name('dana')}@example.com`;
        context.state.set('userName', userName);
        await findNone(
          context,
          filter(context.endpoints.users, `userName eq ${quoted(userName)}`, '&startIndex=1&count=100'),
        );
      },
    },
    {
      name: 'Creates the user (with password and empty groups)',
      needs: ['userName'],
      async run(context) {
        const userName = context.state.get('userName') as string;
        const user = await create(context, context.endpoints.users, 'user', {
          schemas: [USER],
          userName,
          name: { givenName: 'Dana', familyName: 'Scully' },
          emails: [{ primary: true, value: userName, type: 'work' }],
          displayName: 'Dana Scully',
          locale: 'en-US',
          externalId: `00u${randomUUID().replace(/-/g, '').slice(0, 17)}`,
          groups: [],
          password: `Pw-${randomUUID()}`,
          active: true,
        });
        expectTrue(user['password'] === undefined, 'the response returns the password');
      },
    },
    {
      name: 'Reads the user',
      needs: ['user'],
      async run(context) {
        const response = await context.client.request('GET', userPath(context));
        expectStatus(response, 200);
        expectEqual(bodyOf(response)['active'], true, 'active');
      },
    },
    {
      name: 'Finds the user by userName',
      needs: ['user', 'userName'],
      async run(context) {
        await findOne(
          context,
          filter(
            context.endpoints.users,
            `userName eq ${quoted(context.state.get('userName') as string)}`,
            '&startIndex=1&count=100',
          ),
          context.state.get('user') as string,
        );
      },
    },
    {
      name: 'Updates the profile with PUT',
      needs: ['user', 'userName'],
      async run(context) {
        const userName = context.state.get('userName') as string;
        const response = await context.client.request('PUT', userPath(context), {
          schemas: [USER],
          id: context.state.get('user'),
          userName,
          name: { givenName: 'Dana', familyName: 'Mulder' },
          emails: [{ primary: true, value: userName, type: 'work' }],
          displayName: 'Dana Mulder',
          locale: 'en-US',
          groups: [],
          active: true,
        });
        expectStatus(response, 200);
        expectEqual(
          (bodyOf(response)['name'] as Json | undefined)?.['familyName'],
          'Mulder',
          'name.familyName',
        );
      },
    },
    {
      name: 'Deactivates the user with a path-less replace',
      needs: ['user'],
      async run(context) {
        const path = userPath(context);
        const response = await context.client.request(
          'PATCH',
          path,
          patch({ op: 'replace', value: { active: false } }),
        );
        expectEqual((await after(context, path, response))['active'], false, 'active');
      },
    },
    {
      name: 'Reactivates the user',
      needs: ['user'],
      async run(context) {
        const path = userPath(context);
        const response = await context.client.request(
          'PATCH',
          path,
          patch({ op: 'replace', value: { active: true } }),
        );
        expectEqual((await after(context, path, response))['active'], true, 'active');
      },
    },
    {
      name: 'Looks the group up before creating it',
      async run(context) {
        context.state.set('groupName', context.name('support'));
        await findNone(
          context,
          filter(
            context.endpoints.groups,
            `displayName eq ${quoted(context.state.get('groupName') as string)}`,
            '&startIndex=1&count=100',
          ),
        );
      },
    },
    {
      name: 'Creates the group',
      needs: ['groupName'],
      async run(context) {
        await create(context, context.endpoints.groups, 'group', {
          schemas: [GROUP],
          displayName: context.state.get('groupName'),
          members: [],
        });
      },
    },
    {
      name: 'Reads the group',
      needs: ['group'],
      async run(context) {
        const response = await context.client.request('GET', groupPath(context));
        expectStatus(response, 200);
        expectEqual(bodyOf(response)['displayName'], context.state.get('groupName'), 'displayName');
      },
    },
    {
      name: 'Pushes a member',
      needs: ['group', 'user'],
      async run(context) {
        const path = groupPath(context);
        const response = await context.client.request(
          'PATCH',
          path,
          patch({
            op: 'add',
            path: 'members',
            value: [{ value: context.state.get('user'), display: context.state.get('userName') }],
          }),
        );
        expectEqual(
          valuesOf(await after(context, path, response), 'members'),
          [context.state.get('user')],
          'member ids',
        );
      },
    },
    {
      name: 'Renames the group (value repeats the id)',
      needs: ['group'],
      async run(context) {
        const path = groupPath(context);
        const renamed = `${context.state.get('groupName') as string}-renamed`;
        const response = await context.client.request(
          'PATCH',
          path,
          patch({ op: 'replace', value: { id: context.state.get('group'), displayName: renamed } }),
        );
        expectEqual((await after(context, path, response))['displayName'], renamed, 'displayName');
      },
    },
    {
      name: 'Removes the member',
      needs: ['group', 'user'],
      async run(context) {
        const path = groupPath(context);
        const response = await context.client.request(
          'PATCH',
          path,
          patch({ op: 'remove', path: `members[value eq ${quoted(context.state.get('user') as string)}]` }),
        );
        expectEqual(valuesOf(await after(context, path, response), 'members'), [], 'member ids');
      },
    },
    {
      name: 'Deletes the group',
      needs: ['group'],
      async run(context) {
        await expectDeleted(context, groupPath(context));
      },
    },
  ],
};

// ------------------------------------------------------------------ Entra

/** The requests the Microsoft Entra ID provisioning service sends, in the order it sends them. */
export const entraProfile: Profile = {
  name: 'entra',
  title: 'Microsoft Entra ID provisioning',
  steps: [
    {
      name: 'Looks the user up before creating it',
      async run(context) {
        context.state.set('userName', `${context.name('erin')}@example.com`);
        await findNone(
          context,
          filter(context.endpoints.users, `userName eq ${quoted(context.state.get('userName') as string)}`),
        );
      },
    },
    {
      name: 'Creates the manager',
      async run(context) {
        await create(context, context.endpoints.users, 'manager', {
          schemas: [USER, ENTERPRISE],
          externalId: randomUUID(),
          userName: `${context.name('morgan')}@example.com`,
          active: true,
          displayName: 'Morgan Manager',
          meta: { resourceType: 'User' },
        });
      },
    },
    {
      name: 'Creates the user with the enterprise extension',
      needs: ['userName'],
      async run(context) {
        const userName = context.state.get('userName') as string;
        const user = await create(context, context.endpoints.users, 'user', {
          schemas: [USER, ENTERPRISE],
          externalId: randomUUID(),
          userName,
          active: true,
          addresses: [
            { primary: false, type: 'work', streetAddress: '1 Microsoft Way', locality: 'Redmond' },
          ],
          displayName: 'Erin Example',
          emails: [{ primary: true, type: 'work', value: userName }],
          meta: { resourceType: 'User' },
          name: { formatted: 'Erin Example', familyName: 'Example', givenName: 'Erin' },
          roles: [],
          [ENTERPRISE]: { employeeNumber: '1001', department: 'Research' },
        });
        expectEqual(
          (user[ENTERPRISE] as Json | undefined)?.['department'],
          'Research',
          'enterprise department',
        );
      },
    },
    {
      name: 'Reads the user',
      needs: ['user'],
      async run(context) {
        const response = await context.client.request('GET', userPath(context));
        expectStatus(response, 200);
        expectEqual(bodyOf(response)['id'], context.state.get('user'), 'id');
      },
    },
    {
      name: 'Finds the user by userName',
      needs: ['user', 'userName'],
      async run(context) {
        await findOne(
          context,
          filter(context.endpoints.users, `userName eq ${quoted(context.state.get('userName') as string)}`),
          context.state.get('user') as string,
        );
      },
    },
    {
      name: 'Updates attributes through value filters',
      needs: ['user'],
      async run(context) {
        const path = userPath(context);
        const email = `${context.name('erin-updated')}@example.com`;
        const response = await context.client.request(
          'PATCH',
          path,
          patch(
            { op: 'Replace', path: 'emails[type eq "work"].value', value: email },
            { op: 'Replace', path: 'name.familyName', value: 'Updated' },
            { op: 'Replace', path: 'addresses[type eq "work"].locality', value: 'Seattle' },
          ),
        );
        const user = await after(context, path, response);
        const work = (user['emails'] as Json[] | undefined)?.find((entry) => entry['type'] === 'work');
        expectEqual(work?.['value'], email, 'work email');
        expectEqual((user['name'] as Json | undefined)?.['familyName'], 'Updated', 'name.familyName');
        const address = (user['addresses'] as Json[] | undefined)?.find((entry) => entry['type'] === 'work');
        expectEqual(address?.['locality'], 'Seattle', 'work address locality');
      },
    },
    {
      name: 'Adds a value that did not exist through a value filter',
      needs: ['user'],
      async run(context) {
        const path = userPath(context);
        const response = await context.client.request(
          'PATCH',
          path,
          patch({ op: 'Add', path: 'phoneNumbers[type eq "mobile"].value', value: '+1 425 555 0100' }),
        );
        const mobile = ((await after(context, path, response))['phoneNumbers'] as Json[] | undefined)?.find(
          (entry) => entry['type'] === 'mobile',
        );
        expectEqual(mobile?.['value'], '+1 425 555 0100', 'mobile phone number');
      },
    },
    {
      name: 'Sets the manager from a bare id',
      needs: ['user', 'manager'],
      async run(context) {
        const path = userPath(context);
        const response = await context.client.request(
          'PATCH',
          path,
          patch({ op: 'Add', path: `${ENTERPRISE}:manager`, value: context.state.get('manager') }),
        );
        const manager = ((await after(context, path, response))[ENTERPRISE] as Json | undefined)?.[
          'manager'
        ] as Json | undefined;
        expectEqual(manager?.['value'], context.state.get('manager'), 'manager.value');
      },
    },
    {
      name: 'Removes the manager',
      needs: ['user'],
      async run(context) {
        const path = userPath(context);
        const response = await context.client.request(
          'PATCH',
          path,
          patch({ op: 'Remove', path: `${ENTERPRISE}:manager` }),
        );
        const extension = (await after(context, path, response))[ENTERPRISE] as Json | undefined;
        expectEqual(extension?.['manager'], undefined, 'manager');
      },
    },
    {
      name: 'Disables the user with active "False"',
      needs: ['user'],
      async run(context) {
        const path = userPath(context);
        const response = await context.client.request(
          'PATCH',
          path,
          patch({ op: 'Replace', path: 'active', value: 'False' }),
        );
        expectEqual((await after(context, path, response))['active'], false, 'active');
      },
    },
    {
      name: 'Re-enables the user',
      needs: ['user'],
      async run(context) {
        const path = userPath(context);
        const response = await context.client.request(
          'PATCH',
          path,
          patch({ op: 'Replace', path: 'active', value: 'True' }),
        );
        expectEqual((await after(context, path, response))['active'], true, 'active');
      },
    },
    {
      name: 'Creates the group (with a non-SCIM schema URI)',
      async run(context) {
        context.state.set('groupName', context.name('research'));
        await create(context, context.endpoints.groups, 'group', {
          schemas: [GROUP, 'http://schemas.microsoft.com/2006/11/ResourceManagement/ADSCIM/Group'],
          externalId: randomUUID(),
          displayName: context.state.get('groupName'),
          meta: { resourceType: 'Group' },
        });
      },
    },
    {
      name: 'Reads the group without members',
      needs: ['group'],
      async run(context) {
        const response = await context.client.request(
          'GET',
          `${groupPath(context)}?excludedAttributes=members`,
        );
        expectStatus(response, 200);
        const body = bodyOf(response);
        expectEqual(body['displayName'], context.state.get('groupName'), 'displayName');
        expectTrue(body['members'] === undefined, 'members is returned although it was excluded');
      },
    },
    {
      name: 'Finds the group by displayName',
      needs: ['group', 'groupName'],
      async run(context) {
        await findOne(
          context,
          filter(
            context.endpoints.groups,
            `displayName eq ${quoted(context.state.get('groupName') as string)}`,
            '&excludedAttributes=members',
          ),
          context.state.get('group') as string,
        );
      },
    },
    {
      name: 'Renames the group',
      needs: ['group'],
      async run(context) {
        const path = groupPath(context);
        const renamed = `${context.state.get('groupName') as string}-renamed`;
        const response = await context.client.request(
          'PATCH',
          path,
          patch({ op: 'Replace', path: 'displayName', value: renamed }),
        );
        expectEqual((await after(context, path, response))['displayName'], renamed, 'displayName');
      },
    },
    {
      name: 'Adds a member with a null $ref',
      needs: ['group', 'user'],
      async run(context) {
        const response = await context.client.request(
          'PATCH',
          groupPath(context),
          patch({ op: 'Add', path: 'members', value: [{ $ref: null, value: context.state.get('user') }] }),
        );
        expectStatus(response, 200, 204);
      },
    },
    {
      name: 'Confirms the membership with a filter',
      needs: ['group', 'user'],
      async run(context) {
        await findOne(
          context,
          filter(
            context.endpoints.groups,
            `id eq ${quoted(context.state.get('group') as string)} and members[value eq ${quoted(context.state.get('user') as string)}]`,
            '&excludedAttributes=members',
          ),
          context.state.get('group') as string,
        );
      },
    },
    {
      name: 'Removes the member with a value list',
      needs: ['group', 'user'],
      async run(context) {
        const response = await context.client.request(
          'PATCH',
          groupPath(context),
          patch({ op: 'Remove', path: 'members', value: [{ $ref: null, value: context.state.get('user') }] }),
        );
        expectStatus(response, 200, 204);
        await findNone(
          context,
          filter(
            context.endpoints.groups,
            `id eq ${quoted(context.state.get('group') as string)} and members[value eq ${quoted(context.state.get('user') as string)}]`,
            '&excludedAttributes=members',
          ),
        );
      },
    },
    {
      name: 'Deletes the group',
      needs: ['group'],
      async run(context) {
        await expectDeleted(context, groupPath(context));
      },
    },
    {
      name: 'Deletes the user',
      needs: ['user'],
      async run(context) {
        await expectDeleted(context, userPath(context));
      },
    },
  ],
};

export const PROFILES: Readonly<Record<'rfc' | 'okta' | 'entra', Profile>> = {
  rfc: rfcProfile,
  okta: oktaProfile,
  entra: entraProfile,
};
