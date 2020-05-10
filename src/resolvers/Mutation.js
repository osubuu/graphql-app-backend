const bcrpyt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('crypto');
const { promisify } = require('util');
const stripe = require('../stripe');

const { transport, makeANiceEmail } = require('../mail');
const { hasPermission, itemOwnershipError, signInError } = require('../utils');

// Mutations in here must match mutations defined in schema.graphql
// info refers to what we want back in our response
const Mutations = {
  async createItem(parent, args, ctx, info) {
    // 1. Check if they are logged in
    if (!ctx.request.userId) {
      signInError();
    }
    // 2. Check if they have create permission
    hasPermission(ctx.request.user, ['ITEMCREATE']);
    const params = {
      data: {
        // this is how we create relationship between item and user
        user: {
          connect: {
            id: ctx.request.userId,
          },
        },
        ...args,
      },
    };
    const item = await ctx.db.mutation.createItem(params, info);
    return item;
  },
  async updateItem(parent, args, ctx, info) {
    // 1. Check if user owns item
    const where = { id: args.id };
    const item = await ctx.db.query.item({ where }, '{ id title user { id } }');
    const ownsItem = item.user.id === ctx.request.userId;
    if (!ownsItem) {
      itemOwnershipError();
    }
    // 2. Check if they have update permission
    hasPermission(ctx.request.user, ['ITEMUPDATE']);
    // 3. Perform update
    const updates = { ...args };
    delete updates.id; // remove id from the updates because not updating ID
    const params = {
      data: updates,
      where: { id: args.id },
    };
    const updatedItem = await ctx.db.mutation.updateItem(params, info);
    return updatedItem;
  },
  async deleteItem(parent, args, ctx, info) {
    const where = { id: args.id };
    // 1. Find item
    const item = await ctx.db.query.item({ where }, '{ id title user { id } }');
    // 2. Check if they own that item or have the permissions
    const ownsItem = item.user.id === ctx.request.userId;
    if (!ownsItem) {
      itemOwnershipError();
    }
    hasPermission(ctx.request.user, ['ITEMDELETE']);
    // 3. Delete it
    return ctx.db.mutation.deleteItem({ where }, info);
  },
  async signup(parent, args, ctx, info) {
    // hash password
    const password = await bcrpyt.hash(args.password, 10);
    // create user in DB
    const user = await ctx.db.mutation.createUser({
      data: {
        ...args,
        email: args.email.toLowerCase(),
        password,
        permissions: { set: ['USER', 'ITEMCREATE', 'ITEMUPDATE', 'ITEMDELETE'] },
      },
    }, info);
    // create the JWT token for user
    const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);
    // we set the JWT as a cookie on the response
    ctx.response.cookie('token', token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365, // 1 year cookie
    });
    // return user to browser
    return user;
  },
  async signin(parent, args, ctx) {
    // 1. Check if there is a user with that email
    const user = await ctx.db.query.user({ where: { email: args.email } });
    if (!user) {
      throw new Error(`No such user found for email ${args.email}`);
    }
    // 2. Check if password is correct
    const valid = await bcrpyt.compare(args.password, user.password);
    if (!valid) {
      throw new Error('Invalid password!');
    }
    // 3. Generate the JWT token
    const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);
    // 4. Set the cookie with the token
    ctx.response.cookie('token', token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365, // 1 year cookie
    });
    // 5. Return the user
    return user;
  },
  signout(parent, args, ctx) {
    ctx.response.clearCookie('token');
    return { message: 'Signed out successfully' };
  },
  async requestReset(parent, args, ctx) {
    // 1. Check if this is a real user
    const user = await ctx.db.query.user({ where: { email: args.email } });
    if (!user) {
      throw new Error(`No such user found for email ${args.email}`);
    }
    // 2. Set a reset token and expiry on that suer
    const randomBytesPromisified = promisify(randomBytes);
    const resetToken = (await randomBytesPromisified(20)).toString('hex');
    const resetTokenExpiry = Date.now() + 3600000; // 1 hour from now
    await ctx.db.mutation.updateUser({
      where: { email: args.email },
      data: { resetToken, resetTokenExpiry },
    });
    // 3. Email them that reset token
    await transport.sendMail({
      from: 'help@hoodify.com',
      to: user.email,
      subject: 'Your Password Reset Token',
      html: makeANiceEmail(
        `Your Password Reset Token is here! \n\n <a href="${process.env.FRONTEND_URL}/reset?resetToken=${resetToken}">Click Here to Reset</a>`,
      ),
    });
    // 4. Return the message
    return { message: 'Success!' };
  },
  async resetPassword(parent, args, ctx) {
    // 1. Check if passwords match
    if (args.password !== args.confirmPassword) {
      throw new Error('Passwords do not match');
    }
    // 2. Check if it's a valid reset token
    // 3. Check if token is expired
    const [user] = await ctx.db.query.users({
      where: {
        resetToken: args.resetToken,
        resetTokenExpiry_gte: Date.now() - 3600000, // gte = greater than or equal to
      },
    });
    if (!user) {
      throw new Error('This token is either invalid or expired');
    }
    // 4. Check if current password is correct
    const valid = await bcrpyt.compare(args.oldPassword, user.password);
    if (!valid) {
      throw new Error('Invalid current password');
    }
    // 5. Hash new password
    const password = await bcrpyt.hash(args.password, 10);
    // 6. Save new password to user and remove old resetToken fields
    const updatedUser = await ctx.db.mutation.updateUser({
      where: { email: user.email },
      data: {
        password,
        resetToken: null,
        resetTokenExpiry: null,
      },
    });
    // 7. Generate JWT
    const token = jwt.sign({ userId: updatedUser.id }, process.env.APP_SECRET);
    // 8. Set the JWT cookie
    ctx.response.cookie('token', token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365, // 1 year cookie
    });
    // 9. Return the new user
    return updatedUser;
  },
  async updatePermissions(parent, args, ctx, info) {
    // 1. Check if they are logged in
    if (!ctx.request.userId) {
      signInError();
    }
    // 2. Query the current user
    const currentUser = await ctx.db.query.user({
      where: {
        id: ctx.request.userId,
      },
    }, info);
    // 3. Check if they have the permissions to do this
    hasPermission(currentUser, ['ADMIN', 'PERMISSIONUPDATE']);
    // 4. Update the permissions
    return ctx.db.mutation.updateUser({
      data: {
        permissions: {
          set: args.permissions,
        },
      },
      where: {
        id: args.userId,
      },
    }, info);
  },
  async addToCart(parent, args, ctx, info) {
    // 1. Make sure they are signed in
    const { userId } = ctx.request;
    if (!userId) {
      signInError();
    }
    // 2. Query the user's current cart
    const [existingCartItem] = await ctx.db.query.cartItems({
      where: {
        user: { id: userId },
        item: { id: args.id },
      },
    });
    // 3. Check if that item is already in their cart and increment by 1 if it is
    if (existingCartItem) {
      return ctx.db.mutation.updateCartItem({
        where: { id: existingCartItem.id },
        data: { quantity: existingCartItem.quantity + 1 },
      }, info);
    }
    // 4. If it's not, create a fresh cart
    return ctx.db.mutation.createCartItem({
      data: {
        user: {
          connect: { id: userId },
        },
        item: {
          connect: { id: args.id },
        },
      },
    }, info);
  },
  async removeFromCart(parent, args, ctx, info) {
    // 1. Find the cart item
    const cartItem = await ctx.db.query.cartItem({
      where: { id: args.id },
    }, '{ id, user { id } }');
    if (!cartItem) {
      throw new Error('No cart item found');
    }
    // 2. Make sure they own cart item
    if (cartItem.user.id !== ctx.request.userId) {
      itemOwnershipError();
    }
    // 3. Delete that cart item
    return ctx.db.mutation.deleteCartItem({
      where: { id: args.id },
    }, info);
  },
  async createOrder(parent, args, ctx) {
    // 1. Query the current user and make sure they are signed in
    const { userId } = ctx.request;
    if (!userId) {
      signInError();
    }
    const user = await ctx.db.query.user({
      where: { id: userId },
    }, '{ id name email cart { id quantity item { title price id description image largeImage } } }');
    // 2. Recalculate the total for the price
    const amount = user.cart.reduce(
      (total, cartItem) => total + cartItem.item.price * cartItem.quantity, 0,
    );
    // 3. Create the Stripe charge (i.e turn token into $$$)
    const charge = await stripe.charges.create({
      amount,
      currency: 'USD',
      source: args.token,
    });
    // 4. Convert the CartItems to OrderItems
    const orderItems = user.cart.map(cartItem => {
      const orderItem = {
        ...cartItem.item,
        quantity: cartItem.quantity,
        user: { connect: { id: userId } },
      };
      delete orderItem.id;
      return orderItem;
    });
    // 5. Create the Order
    const order = await ctx.db.mutation.createOrder({
      data: {
        total: charge.amount,
        charge: charge.id,
        items: { create: orderItems },
        user: { connect: { id: userId } },
      },
    });
    // 6. Clear the user's Cart, delete CartItems
    const cartItemIds = user.cart.map(cartItem => cartItem.id);
    await ctx.db.mutation.deleteManyCartItems({
      where: { id_in: cartItemIds },
    });
    // 7. Return the Order to the client
    return order;
  },
};

module.exports = Mutations;
