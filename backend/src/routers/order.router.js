
import { Router } from 'express';
import handler from 'express-async-handler';
import auth from '../middleware/auth.mid.js';
import { BAD_REQUEST, UNAUTHORIZED } from '../constants/httpStatus.js';
import { OrderModel } from '../models/order.model.js';
import { PaymentModel } from '../models/payment.model.js';

import { OrderStatus } from '../constants/orderStatus.js';
import { UserModel } from '../models/user.model.js';
import { sendEmailReceipt } from '../helpers/mail.helper.js';
import { FoodModel } from '../models/food.model.js';
import admin from '../middleware/admin.mid.js';


// DELETE /orders/:id

const router = Router();
router.use(auth);

router.post(
  '/create',
  handler(async (req, res) => {
    const order = req.body;

    if (order.items.length <= 0)
      return res.status(BAD_REQUEST).send('Cart Is Empty!');

    // Validate prices and sizes
    for (const item of order.items) {
      const product = await FoodModel.findById(item.product);
      if (!product) return res.status(BAD_REQUEST).send('Invalid product in cart!');
      const quantityObj = product.quantities.find(q => q.size === item.size);
      if (!quantityObj) return res.status(BAD_REQUEST).send('Invalid size for product!');
      if (quantityObj.price !== item.price) return res.status(BAD_REQUEST).send('Price mismatch!');
    }

    order.items = order.items.filter(item => item.product);
    if (order.items.length === 0) {
      return res.status(BAD_REQUEST).send('No valid products in cart!');
    }

    const newOrder = new OrderModel({ ...order, user: req.user.id });
    await newOrder.save();

    res.send(newOrder);
  })
);

router.put(
  '/pay',
  handler(async (req, res) => {
    const { paymentId, method = 'PayPal', status = 'COMPLETED' } = req.body;

    const order = await getNewOrderForCurrentUser(req);
    if (!order) return res.status(BAD_REQUEST).send('Order Not Found!');

    // Create Payment entry
    const payment = new PaymentModel({
      order: order._id,
      user: req.user.id,
      paymentId,
      method,
      amount: order.totalPrice,
      status, // can be 'PENDING' or 'COMPLETED'
    });
    await payment.save();

    // Update order only if payment is completed
    if (status === 'COMPLETED') {
      order.paymentId = paymentId;
      order.status = OrderStatus.PAYED;
      await order.save();

      sendEmailReceipt(order);
    }

    res.send({ orderId: order._id, paymentId: payment._id, paymentStatus: status });
  })
);


router.get(
  '/track/:orderId',
  handler(async (req, res) => {
    const { orderId } = req.params;
    const user = await UserModel.findById(req.user.id);

    const filter = {
      _id: orderId,
    };

    if (!user.isAdmin) {
      filter.user = user._id;
    }

    const order = await OrderModel.findOne(filter).populate('items.product');


    if (!order) return res.send(UNAUTHORIZED);

    return res.send(order);
  })
);

router.delete('/:id', async (req, res) => {
  try {
    const deletedOrder = await OrderModel.findByIdAndDelete(req.params.id);
    if (!deletedOrder) {
      return res.status(404).json({ message: 'Order not found' });
    }
    res.json({ message: 'Order deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});


router.get(
  '/newOrderForCurrentUser',
  auth,
  async (req, res) => {
    try {
      const order = await OrderModel.findOne({
        user: req.user.id,
        status: OrderStatus.NEW,
      })
      .populate('user')
      .populate({
        path: 'items.product',
        select: 'name images quantities'
      });

      if (!order) return res.status(404).send({ message: 'No active order found' });

      res.send(order);
    } catch (err) {
      console.error('Error in newOrderForCurrentUser:', err);
      res.status(500).send({ error: err.message });
    }
  }
);


router.get('/allstatus', (req, res) => {
  const allStatus = Object.values(OrderStatus);
  res.send(allStatus);
});

router.get(
  '/:status?',
  handler(async (req, res) => {
    const status = req.params.status;
    const user = await UserModel.findById(req.user.id);
    const filter = {};

    if (!user.isAdmin) filter.user = user._id;
    if (status) filter.status = status;

    const orders = await OrderModel.find(filter)
      .populate('items.product')  // ✅ Populates product details
      .sort('-createdAt');

    res.send(orders);
  })
);


router.get(
  '/orders', admin,
  handler(async (req, res) => {
    const { user, status, from, to } = req.query;
    const filter = {};
    if (user) filter.user = user;
    if (status) filter.status = status;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }
    const orders = await OrderModel.find(filter)
  .populate('items.product')
  .populate('user')
  .populate({ path: 'payment', select: 'status' })  // 👈 Add this if payment is populated
  .sort('-createdAt');

    res.json(orders);
  })
);

// ... existing imports and routes ...

router.patch(
  '/order/:id/status', admin,
  handler(async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const order = await OrderModel.findByIdAndUpdate(id, { status }, { new: true });
    if (!order) return res.status(404).json({ message: 'Order not found' });
    res.json(order);
  })
);

// 🔽 Add below this ↓↓↓
router.patch(
  '/payment/:id/status', admin,
  handler(async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    const payment = await PaymentModel.findByIdAndUpdate(id, { status }, { new: true });
    if (!payment) return res.status(404).json({ message: 'Payment not found' });

    // If status is completed, update order as well
    if (status === 'COMPLETED') {
      const order = await OrderModel.findById(payment.order);
      if (order && order.status !== OrderStatus.PAYED) {
        order.status = OrderStatus.PAYED;
        order.paymentId = payment.paymentId;
        await order.save();
      }
    }

    res.json(payment);
  })
);


router.get('/user-purchase-count', auth, async (req, res) => {
  try {
    console.log('user:', req.user); // Add this
    const count = await OrderModel.countDocuments({ user: req.user.id, status: 'PAYED' });
    res.json({ count });
  } catch (err) {
    console.error('Error in user-purchase-count:', err); // Add this
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.get(
  '/order/:id',
  handler(async (req, res) => {
    const order = await OrderModel.findById(req.params.id)
      .populate('items.product');

    if (!order) return res.status(404).json({ message: 'Order not found' });

    res.json(order);
  })
);


const getNewOrderForCurrentUser = async req =>
  await OrderModel.findOne({
    user: req.user.id,
    status: OrderStatus.NEW,
  })
  .sort({ createdAt: -1 })  // ✅ Sort by latest order
  .populate('user');

export default router;
