import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  defineResourceType,
  defineSchema,
  GroupResourceType,
  type JsonObject,
  type ScimStore,
  UserResourceType,
} from 'scimkit';
import {
  BASE_URL,
  createHarness,
  ENTERPRISE,
  GROUP,
  type Harness,
  patchBody,
  TOKEN_GLOBEX,
  USER,
} from './harness.js';

export interface StoreFixture {
  store: ScimStore;
  /** Removes all data between tests. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

const DEVICE_URN = 'urn:example:scim:schemas:Device';

/** A custom resource type with every attribute type, to check typed filtering and sorting. */
export const DeviceResourceType = defineResourceType({
  name: 'Device',
  schema: defineSchema({
    id: DEVICE_URN,
    name: 'Device',
    attributes: [
      { name: 'displayName', required: true },
      { name: 'serial', caseExact: true, uniqueness: 'server' },
      { name: 'ports', type: 'integer' },
      { name: 'weight', type: 'decimal' },
      { name: 'enrolled', type: 'boolean' },
      { name: 'lastSeen', type: 'dateTime' },
      { name: 'tags', multiValued: true },
      {
        name: 'interfaces',
        type: 'complex',
        multiValued: true,
        subAttributes: [
          { name: 'mac' },
          { name: 'speeds', type: 'integer', multiValued: true },
          { name: 'primary', type: 'boolean' },
        ],
      },
      { name: 'owner', type: 'complex', subAttributes: [{ name: 'value' }, { name: 'name' }] },
    ],
  }),
});

const ids = (body: JsonObject): string[] =>
  ((body['Resources'] as JsonObject[] | undefined) ?? []).map((r) => r['id'] as string);
const names = (body: JsonObject): string[] =>
  ((body['Resources'] as JsonObject[] | undefined) ?? []).map(
    (r) => (r['userName'] ?? r['displayName']) as string,
  );

/**
 * Behaviour every store must have, exercised through the SCIM protocol. The
 * memory store and the PostgreSQL store both run it.
 */
export function describeStoreContract(name: string, setup: () => Promise<StoreFixture>): void {
  describe(`${name} store contract`, () => {
    let fixture: StoreFixture;
    let scim: Harness;

    beforeAll(async () => {
      fixture = await setup();
      scim = createHarness({ store: fixture.store });
    });
    beforeEach(async () => {
      await fixture.reset();
    });
    afterAll(async () => {
      await fixture.close();
    });

    describe('users', () => {
      it('creates, reads and represents a user', async () => {
        const created = await scim.call('POST', '/Users', {
          schemas: [USER, ENTERPRISE],
          externalId: 'ext-1',
          userName: 'ann@example.com',
          name: { givenName: 'Ann', familyName: 'Lee' },
          password: 'Sup3r-secret',
          emails: [{ value: 'ann@example.com', type: 'work', primary: true }],
          [ENTERPRISE]: { department: 'R&D', manager: { value: 'm-1' } },
        });
        expect(created.status).toBe(201);
        const id = created.body['id'] as string;
        expect(created.headers['Location']).toBe(`${BASE_URL}/Users/${id}`);
        expect(created.headers['ETag']).toMatch(/^W\/".+"$/);
        expect(created.body).toMatchObject({
          schemas: [USER, ENTERPRISE],
          externalId: 'ext-1',
          userName: 'ann@example.com',
          [ENTERPRISE]: { department: 'R&D', manager: { value: 'm-1', $ref: `${BASE_URL}/Users/m-1` } },
          meta: {
            resourceType: 'User',
            location: `${BASE_URL}/Users/${id}`,
            version: created.headers['ETag'],
          },
        });
        expect(created.body).not.toHaveProperty('password');
        expect(Date.parse((created.body['meta'] as JsonObject)['created'] as string)).not.toBeNaN();

        const read = await scim.call('GET', `/Users/${id}`);
        expect(read.status).toBe(200);
        expect(read.body).toEqual(created.body);
        expect(read.headers['ETag']).toBe(created.headers['ETag']);
        const cached = await scim.call('GET', `/Users/${id}`, undefined, {
          'if-none-match': created.headers['ETag'] as string,
        });
        expect(cached.status).toBe(304);
      });

      it('answers 404 for unknown ids', async () => {
        const reply = await scim.call('GET', '/Users/00000000-0000-0000-0000-000000000000');
        expect(reply.status).toBe(404);
        expect(reply.body).toMatchObject({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
          status: '404',
        });
      });

      it('keeps userName unique per tenant, case-insensitively', async () => {
        await scim.createUser('Ann@Example.com');
        const duplicate = await scim.call('POST', '/Users', { schemas: [USER], userName: 'ann@example.COM' });
        expect(duplicate.status).toBe(409);
        expect(duplicate.body['scimType']).toBe('uniqueness');
        const otherTenant = await scim.as(TOKEN_GLOBEX)('POST', '/Users', {
          schemas: [USER],
          userName: 'ann@example.com',
        });
        expect(otherTenant.status).toBe(201);
        const second = await scim.createUser('bo@example.com');
        const rename = await scim.call('PUT', `/Users/${second['id'] as string}`, {
          schemas: [USER],
          userName: 'ANN@example.com',
        });
        expect(rename.status).toBe(409);
      });

      it('isolates tenants', async () => {
        const ann = await scim.createUser('ann@example.com');
        const globex = scim.as(TOKEN_GLOBEX);
        expect((await globex('GET', `/Users/${ann['id'] as string}`)).status).toBe(404);
        expect((await globex('DELETE', `/Users/${ann['id'] as string}`)).status).toBe(404);
        expect(
          (
            await globex(
              'PATCH',
              `/Users/${ann['id'] as string}`,
              patchBody({ op: 'replace', path: 'active', value: false }),
            )
          ).status,
        ).toBe(404);
        expect((await globex('GET', '/Users')).body['totalResults']).toBe(0);
        expect((await scim.call('GET', '/Users')).body['totalResults']).toBe(1);
      });

      it('replaces a user and bumps its version', async () => {
        const ann = await scim.createUser('ann@example.com', { title: 'Engineer', active: true });
        const id = ann['id'] as string;
        const replaced = await scim.call('PUT', `/Users/${id}`, {
          schemas: [USER],
          userName: 'ann@example.com',
          nickName: 'A',
        });
        expect(replaced.status).toBe(200);
        expect(replaced.body['title']).toBeUndefined();
        expect(replaced.body['nickName']).toBe('A');
        expect(replaced.headers['ETag']).not.toBe((ann['meta'] as JsonObject)['version']);
        expect((await scim.call('PUT', '/Users/nope', { schemas: [USER], userName: 'x' })).status).toBe(404);
      });

      it('patches a user and leaves the version alone when nothing changes', async () => {
        const ann = await scim.createUser('ann@example.com', {
          active: true,
          emails: [{ value: 'a@x.io', type: 'work' }],
        });
        const id = ann['id'] as string;
        const version = (ann['meta'] as JsonObject)['version'];
        const same = await scim.call(
          'PATCH',
          `/Users/${id}`,
          patchBody({ op: 'replace', value: { active: true } }),
        );
        expect(same.status).toBe(200);
        expect(same.headers['ETag']).toBe(version);
        const changed = await scim.call(
          'PATCH',
          `/Users/${id}`,
          patchBody(
            { op: 'Replace', path: 'active', value: 'False' },
            { op: 'Replace', path: 'emails[type eq "work"].value', value: 'ann@x.io' },
            { op: 'Add', path: 'phoneNumbers[type eq "mobile"].value', value: '555' },
          ),
        );
        expect(changed.status).toBe(200);
        expect(changed.body).toMatchObject({
          active: false,
          emails: [{ value: 'ann@x.io', type: 'work' }],
          phoneNumbers: [{ type: 'mobile', value: '555' }],
        });
        expect(changed.headers['ETag']).not.toBe(version);
      });

      it('honours If-Match', async () => {
        const ann = await scim.createUser('ann@example.com');
        const id = ann['id'] as string;
        const version = (ann['meta'] as JsonObject)['version'] as string;
        const ok = await scim.call(
          'PATCH',
          `/Users/${id}`,
          patchBody({ op: 'replace', path: 'title', value: 'A' }),
          { 'if-match': version },
        );
        expect(ok.status).toBe(200);
        const stale = await scim.call(
          'PATCH',
          `/Users/${id}`,
          patchBody({ op: 'replace', path: 'title', value: 'B' }),
          { 'if-match': version },
        );
        expect(stale.status).toBe(412);
        expect(
          (
            await scim.call(
              'PUT',
              `/Users/${id}`,
              { schemas: [USER], userName: 'x' },
              { 'if-match': version },
            )
          ).status,
        ).toBe(412);
        expect((await scim.call('DELETE', `/Users/${id}`, undefined, { 'if-match': version })).status).toBe(
          412,
        );
        expect((await scim.call('DELETE', `/Users/${id}`, undefined, { 'if-match': '*' })).status).toBe(204);
      });

      it('deletes a user', async () => {
        const ann = await scim.createUser('ann@example.com');
        const id = ann['id'] as string;
        expect((await scim.call('DELETE', `/Users/${id}`)).status).toBe(204);
        expect((await scim.call('GET', `/Users/${id}`)).status).toBe(404);
        expect((await scim.call('DELETE', `/Users/${id}`)).status).toBe(404);
      });
    });

    describe('queries', () => {
      beforeEach(async () => {
        await scim.createUser('carol@example.com', {
          externalId: 'C-3',
          name: { givenName: 'Carol', familyName: 'Zhang' },
          title: 'CTO',
          active: true,
          emails: [
            { value: 'carol@home.example', type: 'home' },
            { value: 'carol@example.com', type: 'work', primary: true },
          ],
          [ENTERPRISE]: { employeeNumber: '300', department: 'Engineering' },
        });
        await scim.createUser('alice@example.com', {
          externalId: 'A-1',
          name: { givenName: 'Alice', familyName: 'Young' },
          active: false,
          emails: [{ value: 'alice@example.com', type: 'work' }],
          [ENTERPRISE]: { employeeNumber: '100', department: 'Sales' },
        });
        await scim.createUser('bob@example.org', {
          externalId: 'B-2',
          name: { givenName: 'Bob', familyName: 'Xu' },
          title: 'Engineer',
          active: true,
          [ENTERPRISE]: { department: 'Engineering' },
        });
      });

      it.each([
        ['userName eq "ALICE@example.com"', ['alice@example.com']],
        ['externalId eq "B-2"', ['bob@example.org']],
        ['externalId eq "b-2"', []],
        ['userName ew ".org"', ['bob@example.org']],
        ['userName sw "c"', ['carol@example.com']],
        ['name.familyName co "u"', ['alice@example.com', 'bob@example.org']],
        ['emails.value co "@home"', ['carol@example.com']],
        ['emails eq "alice@example.com"', ['alice@example.com']],
        ['emails[type eq "work" and value co "carol"]', ['carol@example.com']],
        ['emails[type eq "home"] or title eq "engineer"', ['carol@example.com', 'bob@example.org']],
        ['emails pr', ['carol@example.com', 'alice@example.com']],
        ['not (emails pr)', ['bob@example.org']],
        ['title pr and active eq true', ['carol@example.com', 'bob@example.org']],
        ['active eq false', ['alice@example.com']],
        ['title ne "CTO"', ['alice@example.com', 'bob@example.org']],
        ['title gt "D"', ['bob@example.org']],
        ['title le "cto"', ['carol@example.com']],
        [`${ENTERPRISE}:department eq "engineering"`, ['carol@example.com', 'bob@example.org']],
        [`${ENTERPRISE}:employeeNumber pr`, ['carol@example.com', 'alice@example.com']],
        [
          'meta.created gt "2000-01-01T00:00:00Z"',
          ['carol@example.com', 'alice@example.com', 'bob@example.org'],
        ],
        ['meta.lastModified lt "2000-01-01T00:00:00Z"', []],
        ['meta.resourceType eq "User"', ['carol@example.com', 'alice@example.com', 'bob@example.org']],
        ['nickName eq null', ['carol@example.com', 'alice@example.com', 'bob@example.org']],
        ['userName eq "x" or (externalId eq "A-1" and not (active eq true))', ['alice@example.com']],
      ])('filters %s', async (filter, expected) => {
        const reply = await scim.call('GET', `/Users?filter=${encodeURIComponent(filter)}`);
        expect(reply.status).toBe(200);
        expect(names(reply.body)).toEqual(expected);
        expect(reply.body['totalResults']).toBe(expected.length);
      });

      it('rejects invalid filters', async () => {
        const reply = await scim.call('GET', `/Users?filter=${encodeURIComponent('userName eq')}`);
        expect(reply.status).toBe(400);
        expect(reply.body['scimType']).toBe('invalidFilter');
      });

      it.each([
        ['userName', 'ascending', ['alice@example.com', 'bob@example.org', 'carol@example.com']],
        ['userName', 'descending', ['carol@example.com', 'bob@example.org', 'alice@example.com']],
        ['name.givenName', 'ascending', ['alice@example.com', 'bob@example.org', 'carol@example.com']],
        ['title', 'ascending', ['carol@example.com', 'bob@example.org', 'alice@example.com']],
        ['title', 'descending', ['bob@example.org', 'carol@example.com', 'alice@example.com']],
        ['emails', 'ascending', ['alice@example.com', 'carol@example.com', 'bob@example.org']],
        [
          `${ENTERPRISE}:employeeNumber`,
          'descending',
          ['carol@example.com', 'alice@example.com', 'bob@example.org'],
        ],
        ['meta.created', 'ascending', ['carol@example.com', 'alice@example.com', 'bob@example.org']],
        ['active', 'ascending', ['alice@example.com', 'carol@example.com', 'bob@example.org']],
      ])('sorts by %s %s', async (sortBy, sortOrder, expected) => {
        const reply = await scim.call(
          'GET',
          `/Users?sortBy=${encodeURIComponent(sortBy)}&sortOrder=${sortOrder}`,
        );
        expect(names(reply.body)).toEqual(expected);
      });

      it('returns resources in creation order by default', async () => {
        expect(names((await scim.call('GET', '/Users')).body)).toEqual([
          'carol@example.com',
          'alice@example.com',
          'bob@example.org',
        ]);
      });

      it('paginates', async () => {
        const page = await scim.call('GET', '/Users?sortBy=userName&startIndex=2&count=1');
        expect(page.body).toMatchObject({ totalResults: 3, startIndex: 2, itemsPerPage: 1 });
        expect(names(page.body)).toEqual(['bob@example.org']);
        const past = await scim.call('GET', '/Users?startIndex=10');
        expect(past.body).toMatchObject({ totalResults: 3, startIndex: 10, itemsPerPage: 0, Resources: [] });
        const countOnly = await scim.call('GET', '/Users?count=0');
        expect(countOnly.body).toMatchObject({ totalResults: 3, itemsPerPage: 0, Resources: [] });
        const filteredPage = await scim.call(
          'GET',
          `/Users?filter=${encodeURIComponent('active eq true')}&sortBy=userName&sortOrder=descending&count=1`,
        );
        expect(filteredPage.body).toMatchObject({ totalResults: 2, itemsPerPage: 1 });
        expect(names(filteredPage.body)).toEqual(['carol@example.com']);
      });

      it('searches with POST /.search', async () => {
        const reply = await scim.call('POST', '/Users/.search', {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:SearchRequest'],
          filter: 'active eq true',
          attributes: ['userName'],
          sortBy: 'userName',
          startIndex: 1,
          count: 10,
        });
        expect(reply.status).toBe(200);
        expect(reply.body['Resources']).toEqual([
          { schemas: [USER], id: expect.any(String), userName: 'bob@example.org' },
          { schemas: [USER], id: expect.any(String), userName: 'carol@example.com' },
        ]);
      });

      it('projects attributes', async () => {
        const only = await scim.call(
          'GET',
          '/Users?filter=userName%20eq%20%22carol@example.com%22&attributes=userName,emails.value,urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department',
        );
        expect((only.body['Resources'] as JsonObject[])[0]).toEqual({
          schemas: [USER, ENTERPRISE],
          id: expect.any(String),
          userName: 'carol@example.com',
          emails: [{ value: 'carol@home.example' }, { value: 'carol@example.com' }],
          [ENTERPRISE]: { department: 'Engineering' },
        });
        const without = await scim.call(
          'GET',
          `/Users?excludedAttributes=emails,meta,${ENTERPRISE},name.familyName&count=1`,
        );
        const first = (without.body['Resources'] as JsonObject[])[0] as JsonObject;
        expect(first['emails']).toBeUndefined();
        expect(first['meta']).toBeUndefined();
        expect(first[ENTERPRISE]).toBeUndefined();
        expect(first['schemas']).toEqual([USER]);
        expect(first['name']).toEqual({ givenName: 'Carol' });
        expect(first['id']).toBeDefined();
      });
    });

    describe('groups', () => {
      it('maintains membership in both directions', async () => {
        const ann = await scim.createUser('ann@example.com', { displayName: 'Ann Lee' });
        const bo = await scim.createUser('bo@example.com');
        const annId = ann['id'] as string;
        const boId = bo['id'] as string;
        const group = await scim.createGroup('Engineering', [annId]);
        const groupId = group['id'] as string;
        expect(group['members']).toEqual([
          { value: annId, $ref: `${BASE_URL}/Users/${annId}`, type: 'User', display: 'Ann Lee' },
        ]);
        const annRead = await scim.call('GET', `/Users/${annId}`);
        expect(annRead.body['groups']).toEqual([
          { value: groupId, $ref: `${BASE_URL}/Groups/${groupId}`, display: 'Engineering', type: 'direct' },
        ]);
        expect(annRead.headers['ETag']).not.toBe((ann['meta'] as JsonObject)['version']);

        const added = await scim.call(
          'PATCH',
          `/Groups/${groupId}`,
          patchBody({ op: 'add', path: 'members', value: [{ value: boId }] }),
        );
        expect(added.status).toBe(200);
        expect((added.body['members'] as JsonObject[]).map((m) => m['value'])).toEqual([annId, boId]);
        expect(
          ((await scim.call('GET', `/Users/${boId}`)).body['groups'] as JsonObject[])[0]?.['value'],
        ).toBe(groupId);

        const check = `id eq "${groupId}" and members[value eq "${boId}"]`;
        const membership = await scim.call(
          'GET',
          `/Groups?excludedAttributes=members&filter=${encodeURIComponent(check)}`,
        );
        expect(membership.body['totalResults']).toBe(1);
        expect((membership.body['Resources'] as JsonObject[])[0]).not.toHaveProperty('members');

        const userFilter = await scim.call(
          'GET',
          `/Users?filter=${encodeURIComponent(`groups[value eq "${groupId}"]`)}&sortBy=userName`,
        );
        expect(names(userFilter.body)).toEqual(['ann@example.com', 'bo@example.com']);
        const byGroupName = await scim.call(
          'GET',
          `/Users?filter=${encodeURIComponent('groups.display eq "engineering"')}`,
        );
        expect(byGroupName.body['totalResults']).toBe(2);

        const removed = await scim.call(
          'PATCH',
          `/Groups/${groupId}`,
          patchBody({ op: 'Remove', path: 'members', value: [{ $ref: null, value: annId }] }),
        );
        expect((removed.body['members'] as JsonObject[]).map((m) => m['value'])).toEqual([boId]);
        expect((await scim.call('GET', `/Users/${annId}`)).body['groups']).toBeUndefined();
        const gone = await scim.call(
          'GET',
          `/Groups?filter=${encodeURIComponent(`id eq "${groupId}" and members[value eq "${annId}"]`)}`,
        );
        expect(gone.body['totalResults']).toBe(0);
      });

      it('validates members', async () => {
        const missing = await scim.call('POST', '/Groups', {
          schemas: [GROUP],
          displayName: 'X',
          members: [{ value: 'nobody' }],
        });
        expect(missing.status).toBe(400);
        expect(missing.body['scimType']).toBe('invalidValue');
        const ann = await scim.createUser('ann@example.com');
        const wrongType = await scim.call('POST', '/Groups', {
          schemas: [GROUP],
          displayName: 'X',
          members: [{ value: ann['id'], type: 'Group' }],
        });
        expect(wrongType.status).toBe(400);
        const group = await scim.createGroup('Self');
        const self = await scim.call(
          'PATCH',
          `/Groups/${group['id'] as string}`,
          patchBody({ op: 'add', path: 'members', value: [{ value: group['id'] }] }),
        );
        expect(self.status).toBe(400);
        const otherTenant = await scim.as(TOKEN_GLOBEX)('POST', '/Groups', {
          schemas: [GROUP],
          displayName: 'X',
          members: [{ value: ann['id'] }],
        });
        expect(otherTenant.status).toBe(400);
      });

      it('supports nested groups', async () => {
        const ann = await scim.createUser('ann@example.com');
        const inner = await scim.createGroup('Inner', [ann['id'] as string]);
        const outer = await scim.createGroup('Outer', [inner['id'] as string]);
        expect(outer['members']).toEqual([
          {
            value: inner['id'],
            $ref: `${BASE_URL}/Groups/${inner['id'] as string}`,
            type: 'Group',
            display: 'Inner',
          },
        ]);
        expect((await scim.call('DELETE', `/Groups/${inner['id'] as string}`)).status).toBe(204);
        expect((await scim.call('GET', `/Groups/${outer['id'] as string}`)).body['members']).toBeUndefined();
      });

      it('removes deleted users from groups and bumps the group version', async () => {
        const ann = await scim.createUser('ann@example.com');
        const bo = await scim.createUser('bo@example.com');
        const group = await scim.createGroup('Team', [ann['id'] as string, bo['id'] as string]);
        expect((await scim.call('DELETE', `/Users/${ann['id'] as string}`)).status).toBe(204);
        const read = await scim.call('GET', `/Groups/${group['id'] as string}`);
        expect((read.body['members'] as JsonObject[]).map((m) => m['value'])).toEqual([bo['id']]);
        expect(read.headers['ETag']).not.toBe((group['meta'] as JsonObject)['version']);
      });

      it('updates users when a group is deleted or renamed', async () => {
        const ann = await scim.createUser('ann@example.com');
        const group = await scim.createGroup('Team', [ann['id'] as string]);
        const renamed = await scim.call(
          'PATCH',
          `/Groups/${group['id'] as string}`,
          patchBody({ op: 'replace', value: { id: group['id'], displayName: 'Squad' } }),
        );
        expect(renamed.body['displayName']).toBe('Squad');
        expect(
          ((await scim.call('GET', `/Users/${ann['id'] as string}`)).body['groups'] as JsonObject[])[0]?.[
            'display'
          ],
        ).toBe('Squad');
        expect((await scim.call('DELETE', `/Groups/${group['id'] as string}`)).status).toBe(204);
        expect((await scim.call('GET', `/Users/${ann['id'] as string}`)).body['groups']).toBeUndefined();
      });

      it('replaces the member list with PUT', async () => {
        const ann = await scim.createUser('ann@example.com');
        const bo = await scim.createUser('bo@example.com');
        const group = await scim.createGroup('Team', [ann['id'] as string]);
        const replaced = await scim.call('PUT', `/Groups/${group['id'] as string}`, {
          schemas: [GROUP],
          displayName: 'Team',
          members: [{ value: bo['id'] }, { value: bo['id'] }],
        });
        expect(replaced.status).toBe(200);
        expect((replaced.body['members'] as JsonObject[]).map((m) => m['value'])).toEqual([bo['id']]);
        expect((await scim.call('GET', `/Users/${ann['id'] as string}`)).body['groups']).toBeUndefined();
      });

      it('keeps members in the order they joined', async () => {
        const a = await scim.createUser('a@example.com');
        const b = await scim.createUser('b@example.com');
        const c = await scim.createUser('c@example.com');
        const group = await scim.createGroup('Ordered', [a['id'] as string, b['id'] as string]);
        const replaced = await scim.call('PUT', `/Groups/${group['id'] as string}`, {
          schemas: [GROUP],
          displayName: 'Ordered',
          members: [{ value: c['id'] }, { value: b['id'] }, { value: a['id'] }],
        });
        expect((replaced.body['members'] as JsonObject[]).map((m) => m['value'])).toEqual([
          a['id'],
          b['id'],
          c['id'],
        ]);
      });

      it('lists and filters groups', async () => {
        await scim.createGroup('Beta');
        await scim.createGroup('alpha');
        const sorted = await scim.call('GET', '/Groups?sortBy=displayName');
        expect(names(sorted.body)).toEqual(['alpha', 'Beta']);
        const filtered = await scim.call(
          'GET',
          `/Groups?filter=${encodeURIComponent('displayName eq "BETA"')}`,
        );
        expect(ids(filtered.body)).toHaveLength(1);
        const empty = await scim.call('GET', `/Groups?filter=${encodeURIComponent('members pr')}`);
        expect(empty.body['totalResults']).toBe(0);
      });
    });

    describe('custom resource types', () => {
      let devices: Harness;
      beforeAll(() => {
        devices = createHarness({
          store: fixture.store,
          resourceTypes: [UserResourceType, GroupResourceType, DeviceResourceType],
        });
      });
      beforeEach(async () => {
        const create = async (body: JsonObject) => {
          const reply = await devices.call('POST', '/Devices', { schemas: [DEVICE_URN], ...body });
          if (reply.status !== 201) throw new Error(JSON.stringify(reply.body));
        };
        await create({
          displayName: 'Laptop',
          serial: 'SN-1',
          ports: 4,
          weight: 1.25,
          enrolled: true,
          lastSeen: '2024-05-01T10:00:00Z',
          tags: ['corp', 'lap'],
          interfaces: [{ mac: 'AA:01', speeds: [100, 1000], primary: true }],
          owner: { value: 'u1', name: 'Ann' },
        });
        await create({
          displayName: 'Phone',
          serial: 'SN-2',
          ports: 1,
          weight: 0.2,
          enrolled: false,
          lastSeen: '2024-06-01T10:00:00+02:00',
          tags: ['byod'],
          interfaces: [{ mac: 'bb:02', speeds: [10] }],
        });
        await create({
          displayName: 'Printer',
          serial: 'sn-3',
          ports: 8,
          weight: 12,
          owner: { name: 'Ops' },
        });
      });

      it.each([
        ['ports gt 2', ['Laptop', 'Printer']],
        ['ports le 1', ['Phone']],
        ['ports eq 4', ['Laptop']],
        ['ports ne 4', ['Phone', 'Printer']],
        ['weight ge 1.25', ['Laptop', 'Printer']],
        ['weight lt 1', ['Phone']],
        ['enrolled eq false', ['Phone']],
        ['enrolled ne true', ['Phone', 'Printer']],
        ['enrolled pr', ['Laptop', 'Phone']],
        ['lastSeen gt "2024-05-15T00:00:00Z"', ['Phone']],
        ['lastSeen le "2024-05-01T12:00:00+02:00"', ['Laptop']],
        ['lastSeen eq "2024-05-01T10:00:00.000Z"', ['Laptop']],
        ['lastSeen ne "2024-05-01T10:00:00Z"', ['Phone', 'Printer']],
        ['tags eq "CORP"', ['Laptop']],
        ['tags co "o"', ['Laptop', 'Phone']],
        ['tags pr', ['Laptop', 'Phone']],
        ['tags ne "corp"', ['Laptop', 'Phone']],
        ['interfaces.mac eq "BB:02"', ['Phone']],
        ['interfaces[mac sw "aa" and primary eq true]', ['Laptop']],
        ['interfaces.speeds ge 1000', ['Laptop']],
        ['interfaces[speeds eq 10]', ['Phone']],
        ['interfaces.speeds pr', ['Laptop', 'Phone']],
        ['interfaces.primary eq true', ['Laptop']],
        ['owner eq "u1"', ['Laptop']],
        ['owner.name pr', ['Laptop', 'Printer']],
        ['owner[name eq "ops"]', ['Printer']],
        ['owner pr', ['Laptop', 'Printer']],
        ['serial eq "SN-3"', []],
        ['serial eq "sn-3"', ['Printer']],
        ['serial gt "SN-2"', ['Printer']],
        ['not (tags pr) and ports gt 2', ['Printer']],
        ['meta.resourceType eq "Device"', ['Laptop', 'Phone', 'Printer']],
      ])('filters devices by %s', async (filter, expected) => {
        const reply = await devices.call('GET', `/Devices?filter=${encodeURIComponent(filter)}`);
        expect(reply.status).toBe(200);
        expect(names(reply.body)).toEqual(expected);
      });

      it.each([
        ['ports', 'descending', ['Printer', 'Laptop', 'Phone']],
        ['weight', 'ascending', ['Phone', 'Laptop', 'Printer']],
        ['lastSeen', 'ascending', ['Laptop', 'Phone', 'Printer']],
        ['lastSeen', 'descending', ['Phone', 'Laptop', 'Printer']],
        ['enrolled', 'ascending', ['Phone', 'Laptop', 'Printer']],
        ['serial', 'ascending', ['Laptop', 'Phone', 'Printer']],
        ['serial', 'descending', ['Printer', 'Phone', 'Laptop']],
        ['interfaces.mac', 'ascending', ['Laptop', 'Phone', 'Printer']],
        ['tags', 'ascending', ['Phone', 'Laptop', 'Printer']],
        ['owner.name', 'descending', ['Printer', 'Laptop', 'Phone']],
      ])('sorts devices by %s %s', async (sortBy, sortOrder, expected) => {
        const reply = await devices.call('GET', `/Devices?sortBy=${sortBy}&sortOrder=${sortOrder}`);
        expect(names(reply.body)).toEqual(expected);
      });

      it('enforces case-sensitive uniqueness of a custom attribute', async () => {
        const duplicate = await devices.call('POST', '/Devices', {
          schemas: [DEVICE_URN],
          displayName: 'Clone',
          serial: 'SN-1',
        });
        expect(duplicate.status).toBe(409);
        const otherCase = await devices.call('POST', '/Devices', {
          schemas: [DEVICE_URN],
          displayName: 'Clone',
          serial: 'sn-1',
        });
        expect(otherCase.status).toBe(201);
      });
    });
  });
}
